//go:build relay_fuse

package vfsmount

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/PekingSpades/Synapse/relay/internal/vfs"
	"github.com/winfsp/cgofuse/fuse"
)

type MountFS struct {
	fuse.FileSystemBase

	service *vfs.Service

	handleSeq atomic.Uint64

	mu      sync.Mutex
	handles map[uint64]*openHandle
}

type openHandle struct {
	path     string
	writable bool
	buf      []byte
	dirty    bool
	loaded   bool
}

func New(service *vfs.Service) *MountFS {
	return &MountFS{
		service: service,
		handles: make(map[uint64]*openHandle),
	}
}

func (fs *MountFS) Getattr(path string, stat *fuse.Stat_t, fh uint64) int {
	entry, err := fs.service.Stat(path)
	if err != nil {
		return errnoFor(err)
	}
	now := fuse.Now()
	stat.Atim = now
	stat.Mtim = now
	stat.Ctim = now
	stat.Birthtim = now
	if entry.Kind == vfs.NodeKindDirectory {
		stat.Mode = fuse.S_IFDIR | 0555
		stat.Nlink = 2
		return 0
	}
	mode := uint32(0444)
	if entry.Writable {
		mode = 0666
	}
	size := entry.Size
	if size == 0 && !entry.Writable {
		result, err := fs.service.Read(path)
		if err != nil {
			return errnoFor(err)
		}
		size = int64(len(result.Data))
	}
	stat.Mode = fuse.S_IFREG | mode
	stat.Nlink = 1
	stat.Size = size
	return 0
}

func (fs *MountFS) Access(path string, mask uint32) int {
	entry, err := fs.service.Stat(path)
	if err != nil {
		return errnoFor(err)
	}
	if entry.Kind == vfs.NodeKindDirectory {
		return 0
	}
	if entry.Writable {
		return 0
	}
	if mask&2 != 0 {
		return -fuse.EACCES
	}
	return 0
}

func (fs *MountFS) Open(path string, flags int) (int, uint64) {
	entry, err := fs.service.Stat(path)
	if err != nil {
		return errnoFor(err), 0
	}
	if entry.Kind == vfs.NodeKindDirectory {
		return -fuse.EISDIR, 0
	}
	writable := entry.Writable && (flags&fuse.O_ACCMODE) != fuse.O_RDONLY
	if !entry.Writable && (flags&fuse.O_ACCMODE) != fuse.O_RDONLY {
		return -fuse.EACCES, 0
	}
	handle := &openHandle{
		path:     path,
		writable: writable,
	}
	if !writable {
		result, err := fs.service.Read(path)
		if err != nil {
			return errnoFor(err), 0
		}
		handle.buf = append([]byte(nil), result.Data...)
		handle.loaded = true
	}
	handleID := fs.handleSeq.Add(1)
	fs.mu.Lock()
	fs.handles[handleID] = handle
	fs.mu.Unlock()
	return 0, handleID
}

func (fs *MountFS) Create(path string, flags int, mode uint32) (int, uint64) {
	return fs.Open(path, flags)
}

func (fs *MountFS) Read(path string, buff []byte, ofst int64, fh uint64) int {
	handle := fs.getHandle(fh)
	if handle != nil && (handle.dirty || handle.loaded) {
		return copyRange(buff, handle.buf, ofst)
	}
	result, err := fs.service.Read(path)
	if err != nil {
		return errnoFor(err)
	}
	return copyRange(buff, result.Data, ofst)
}

func (fs *MountFS) Write(path string, buff []byte, ofst int64, fh uint64) int {
	handle := fs.getHandle(fh)
	if handle == nil {
		return -fuse.EIO
	}
	if !handle.writable {
		return -fuse.EACCES
	}

	needed := int(ofst) + len(buff)
	if needed > len(handle.buf) {
		next := make([]byte, needed)
		copy(next, handle.buf)
		handle.buf = next
	}
	copy(handle.buf[int(ofst):], buff)
	handle.dirty = true
	return len(buff)
}

func (fs *MountFS) Truncate(path string, size int64, fh uint64) int {
	handle := fs.getHandle(fh)
	if handle == nil {
		return 0
	}
	if !handle.writable {
		return -fuse.EACCES
	}
	switch {
	case size < 0:
		return -fuse.EINVAL
	case int(size) < len(handle.buf):
		handle.buf = handle.buf[:size]
	case int(size) > len(handle.buf):
		next := make([]byte, size)
		copy(next, handle.buf)
		handle.buf = next
	}
	return 0
}

func (fs *MountFS) Flush(path string, fh uint64) int {
	handle := fs.getHandle(fh)
	if handle == nil {
		return 0
	}
	return fs.commitHandle(handle)
}

func (fs *MountFS) Release(path string, fh uint64) int {
	fs.mu.Lock()
	handle := fs.handles[fh]
	delete(fs.handles, fh)
	fs.mu.Unlock()
	if handle == nil {
		return 0
	}
	return fs.commitHandle(handle)
}

func (fs *MountFS) Readdir(
	path string,
	fill func(name string, stat *fuse.Stat_t, ofst int64) bool,
	ofst int64,
	fh uint64,
) int {
	entries, err := fs.service.List(path)
	if err != nil {
		return errnoFor(err)
	}
	fill(".", nil, 0)
	fill("..", nil, 0)
	for _, entry := range entries {
		fill(entry.Name, nil, 0)
	}
	return 0
}

func (fs *MountFS) getHandle(fh uint64) *openHandle {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.handles[fh]
}

func (fs *MountFS) commitHandle(handle *openHandle) int {
	if handle == nil || !handle.writable || !handle.dirty {
		return 0
	}
	if _, err := fs.service.Write(handle.path, handle.buf); err != nil {
		return errnoFor(err)
	}
	handle.dirty = false
	return 0
}

func copyRange(dst []byte, src []byte, ofst int64) int {
	if ofst >= int64(len(src)) {
		return 0
	}
	n := copy(dst, src[ofst:])
	return n
}

func errnoFor(err error) int {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, vfs.ErrNotFound):
		return -fuse.ENOENT
	case errors.Is(err, vfs.ErrNotDirectory):
		return -fuse.ENOTDIR
	case errors.Is(err, vfs.ErrIsDirectory):
		return -fuse.EISDIR
	default:
		return -fuse.EIO
	}
}

type DoctorResult struct {
	Platform            string   `json:"platform"`
	CUARuntimeSupported bool     `json:"cuaRuntimeSupported"`
	DependencyChecks    []Check  `json:"dependencyChecks"`
	UnmountCommands     []string `json:"unmountCommands,omitempty"`
}

type Check struct {
	Name    string `json:"name"`
	OK      bool   `json:"ok"`
	Details string `json:"details,omitempty"`
}

func Doctor() DoctorResult {
	result := DoctorResult{
		Platform:            runtime.GOOS,
		CUARuntimeSupported: vfs.CUARuntimeSupported(),
		DependencyChecks:    []Check{},
	}
	switch runtime.GOOS {
	case "linux":
		result.DependencyChecks = append(result.DependencyChecks,
			checkLookPath("fusermount3"),
			checkLookPath("fusermount"),
			checkPathExists("/dev/fuse"),
		)
		result.UnmountCommands = []string{"fusermount3 -u <mountpoint>", "fusermount -u <mountpoint>", "umount <mountpoint>"}
	case "darwin":
		result.DependencyChecks = append(result.DependencyChecks,
			checkPathExists("/Library/Filesystems/macfuse.fs"),
			checkLookPath("mount_macfuse"),
		)
		result.UnmountCommands = []string{"umount <mountpoint>"}
	case "windows":
		result.DependencyChecks = append(result.DependencyChecks,
			checkLookPath("mountvol"),
			checkWindowsWinFsp(),
		)
		result.UnmountCommands = []string{"mountvol X: /d"}
	}
	return result
}

func checkLookPath(name string) Check {
	resolved, err := exec.LookPath(name)
	if err != nil {
		return Check{Name: name, OK: false, Details: err.Error()}
	}
	return Check{Name: name, OK: true, Details: resolved}
}

func checkPathExists(name string) Check {
	if _, err := os.Stat(name); err == nil {
		return Check{Name: name, OK: true, Details: name}
	}
	return Check{Name: name, OK: false, Details: "not found"}
}

func checkWindowsWinFsp() Check {
	if runtime.GOOS != "windows" {
		return Check{Name: "winfsp", OK: false, Details: "windows only"}
	}
	paths := []string{
		`C:\Program Files\WinFsp\bin\winfsp-x64.dll`,
		`C:\Program Files (x86)\WinFsp\bin\winfsp-x64.dll`,
	}
	for _, candidate := range paths {
		if _, err := os.Stat(candidate); err == nil {
			return Check{Name: "WinFsp", OK: true, Details: candidate}
		}
	}
	return Check{Name: "WinFsp", OK: false, Details: "WinFsp runtime not found in Program Files"}
}

func Mount(
	ctx context.Context,
	service *vfs.Service,
	target string,
	options []string,
) error {
	fs := New(service)
	host := fuse.NewFileSystemHost(fs)
	if len(options) == 0 {
		options = defaultMountOptions()
	}
	done := make(chan bool, 1)
	go func() {
		done <- host.Mount(target, options)
	}()

	select {
	case ok := <-done:
		if !ok {
			return fmt.Errorf("mount failed")
		}
		return nil
	case <-ctx.Done():
		host.Unmount()
		<-done
		return ctx.Err()
	}
}

func UnmountTarget(target string) error {
	switch runtime.GOOS {
	case "linux":
		for _, candidate := range [][]string{{"fusermount3", "-u", target}, {"fusermount", "-u", target}, {"umount", target}} {
			if err := exec.Command(candidate[0], candidate[1:]...).Run(); err == nil {
				return nil
			}
		}
		return fmt.Errorf("failed to unmount %s with fusermount3/fusermount/umount", target)
	case "darwin":
		return exec.Command("umount", target).Run()
	case "windows":
		if !strings.HasSuffix(target, ":") {
			target += ":"
		}
		return exec.Command("mountvol", target, "/d").Run()
	default:
		return fmt.Errorf("unmount is not implemented on %s", runtime.GOOS)
	}
}

func defaultMountOptions() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{}
	default:
		return []string{"-o", "fsname=synapse-relayfs"}
	}
}
