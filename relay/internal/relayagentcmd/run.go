package relayagentcmd

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/PekingSpades/Synapse/relay/internal/relayagent"
	"github.com/PekingSpades/Synapse/relay/internal/relayipc"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
)

func Run(version string, args []string) int {
	flags := flag.NewFlagSet("synapse-relay-agent", flag.ContinueOnError)
	hostKindFlag := flags.String("host-kind", string(relaypaths.HostStandalone), "host kind: standalone, im, or cli")
	sharedRootFlag := flags.String("shared-root", "", "shared relay root")
	profilesRootFlag := flags.String("profiles-root", "", "profiles root")
	profileIDFlag := flags.String("profile-id", "", "profile identifier")
	ipcEndpointFlag := flags.String("ipc-endpoint", "", "IPC endpoint path")
	ipcTokenFlag := flags.String("ipc-token", "", "IPC auth token")
	if err := flags.Parse(args); err != nil {
		return 2
	}

	hostKind := relaypaths.HostKind(strings.TrimSpace(*hostKindFlag))
	if hostKind == "" {
		hostKind = relaypaths.HostStandalone
	}

	hostPaths := relaypaths.DefaultHostPaths(hostKind)
	if strings.TrimSpace(*sharedRootFlag) != "" {
		hostPaths.SharedRoot = strings.TrimSpace(*sharedRootFlag)
	}
	if strings.TrimSpace(*profilesRootFlag) != "" {
		hostPaths.ProfilesRoot = strings.TrimSpace(*profilesRootFlag)
	}

	profileID := strings.TrimSpace(*profileIDFlag)
	var paths relaypaths.ResolvedPaths
	switch hostKind {
	case relaypaths.HostStandalone:
		paths = relaypaths.ResolveStandaloneProfile(hostPaths)
		if profileID != "" && profileID != paths.ProfileID {
			paths = relaypaths.ResolveIMProfile(hostPaths, relaypaths.ProfileDescriptor{
				HostKind:  hostKind,
				ProfileID: profileID,
			})
		}
	default:
		if profileID == "" {
			fmt.Fprintln(os.Stderr, "profile-id is required for non-standalone relay-agent hosts")
			return 2
		}
		paths = relaypaths.ResolveIMProfile(hostPaths, relaypaths.ProfileDescriptor{
			HostKind:  hostKind,
			ProfileID: profileID,
		})
	}

	relaypaths.SetCurrent(paths)

	ipcEndpoint := strings.TrimSpace(*ipcEndpointFlag)
	if ipcEndpoint == "" {
		ipcEndpoint = paths.ControlPlanePath
	}
	ipcToken := strings.TrimSpace(*ipcTokenFlag)
	if ipcToken == "" {
		fmt.Fprintln(os.Stderr, "ipc-token is required")
		return 2
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	agent, err := relayagent.New(paths, ipcEndpoint, relayipc.HelloParams{
		Token:       ipcToken,
		HostKind:    string(hostKind),
		HostVersion: version,
		ProfileID:   paths.ProfileID,
	}, version)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start relay agent: %v\n", err)
		return 1
	}

	go func() {
		<-ctx.Done()
		_ = agent.Stop()
	}()

	if err := agent.Start(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "listen relay agent IPC: %v\n", err)
		return 1
	}

	agent.Wait()
	return 0
}
