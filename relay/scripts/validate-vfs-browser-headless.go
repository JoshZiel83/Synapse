package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/PekingSpades/Synapse/relay/internal/config"
	"github.com/PekingSpades/Synapse/relay/internal/relaypaths"
	"github.com/PekingSpades/Synapse/relay/internal/vfs"
)

type browserTreeSnapshot struct {
	Backend   string                 `json:"backend"`
	URL       string                 `json:"url"`
	NodeCount int                    `json:"nodeCount"`
	Nodes     []browserTreeNodeEntry `json:"nodes"`
}

type browserTreeNodeEntry struct {
	ID         string            `json:"id"`
	PathID     string            `json:"pathId"`
	Tag        string            `json:"tag"`
	Name       string            `json:"name"`
	Text       string            `json:"text"`
	Summary    string            `json:"summary"`
	Actions    []string          `json:"actions"`
	Attributes map[string]string `json:"attributes"`
}

func main() {
	configPath := flag.String("config", "", "relay config path")
	targetURL := flag.String("url", "", "fixture url")
	marker := flag.String("marker", "relayfs-dom-ok", "marker text to write into the page")
	placeholder := flag.String("placeholder", "RelayFS input marker", "input placeholder used to find the fill node")
	buttonText := flag.String("button-text", "Apply marker", "button text used to find the click node")
	flag.Parse()

	if strings.TrimSpace(*configPath) == "" {
		fatalf("missing --config")
	}
	if strings.TrimSpace(*targetURL) == "" {
		fatalf("missing --url")
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		fatalf("load config: %v", err)
	}

	paths := relaypaths.ResolveStandaloneProfile(relaypaths.DefaultHostPaths(relaypaths.HostCLI))
	relaypaths.SetCurrent(paths)

	service, err := vfs.New(paths, cfg)
	if err != nil {
		fatalf("init relay vfs: %v", err)
	}
	startCtx, startCancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer startCancel()
	if err := service.Start(startCtx); err != nil {
		fatalf("start relay vfs: %v", err)
	}
	defer service.Close()

	exposureKey, err := firstExposureName(service, "/browser")
	if err != nil {
		fatalf("discover browser exposure: %v", err)
	}
	sessionRoot := "/browser/" + exposureKey + "/sessions/default"

	if _, err := service.Write(sessionRoot+"/actions/new_page", []byte(*targetURL)); err != nil {
		fatalf("open fixture page: %v", err)
	}

	tree, err := waitForTree(service, sessionRoot, func(tree browserTreeSnapshot) error {
		if tree.Backend != "dom" {
			return fmt.Errorf("expected backend=dom, got %q", tree.Backend)
		}
		if tree.NodeCount <= 0 {
			return fmt.Errorf("expected nodeCount > 0")
		}
		if !sameTargetURL(tree.URL, *targetURL) {
			return fmt.Errorf("expected tree URL %q, got %q", *targetURL, tree.URL)
		}
		return nil
	})
	if err != nil {
		fatalf("wait for browser tree: %v", err)
	}

	fillNode, clickNode, err := findActionNodes(tree, *placeholder, *buttonText)
	if err != nil {
		fatalf("find browser nodes: %v", err)
	}

	if _, err := service.Write(sessionRoot+"/tree/nodes/"+fillNode+"/actions/fill", []byte(*marker)); err != nil {
		fatalf("fill DOM node: %v", err)
	}
	if _, err := service.Write(sessionRoot+"/tree/nodes/"+clickNode+"/actions/click", []byte("{}")); err != nil {
		fatalf("click DOM node: %v", err)
	}

	if _, err := waitForTree(service, sessionRoot, func(tree browserTreeSnapshot) error {
		if !treeContainsMarker(tree, *marker) {
			return fmt.Errorf("marker %q not found in DOM tree", *marker)
		}
		return nil
	}); err != nil {
		fatalf("wait for DOM marker: %v", err)
	}

	if err := assertNonEmptyRead(service, sessionRoot+"/pages/list.json"); err != nil {
		fatalf("pages/list.json: %v", err)
	}
	if err := assertNonEmptyRead(service, sessionRoot+"/current/page.json"); err != nil {
		fatalf("current/page.json: %v", err)
	}
	if err := assertNonEmptyRead(service, sessionRoot+"/tree/index.json"); err != nil {
		fatalf("tree/index.json: %v", err)
	}

	fmt.Printf("validated browser exposure %s via persistent VFS service\n", exposureKey)
}

func firstExposureName(service *vfs.Service, target string) (string, error) {
	entries, err := service.List(target)
	if err != nil {
		return "", err
	}
	if len(entries) == 0 {
		return "", fmt.Errorf("no entries under %s", target)
	}
	return entries[0].Name, nil
}

func waitForTree(service *vfs.Service, sessionRoot string, validate func(browserTreeSnapshot) error) (browserTreeSnapshot, error) {
	deadline := time.Now().Add(20 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		tree, err := readTree(service, sessionRoot)
		if err == nil {
			if validateErr := validate(tree); validateErr == nil {
				return tree, nil
			} else {
				lastErr = validateErr
			}
		} else {
			lastErr = err
		}
		time.Sleep(300 * time.Millisecond)
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("timed out waiting for browser tree")
	}
	return browserTreeSnapshot{}, lastErr
}

func readTree(service *vfs.Service, sessionRoot string) (browserTreeSnapshot, error) {
	result, err := service.Read(sessionRoot + "/tree/index.json")
	if err != nil {
		return browserTreeSnapshot{}, err
	}
	var tree browserTreeSnapshot
	if err := json.Unmarshal(result.Data, &tree); err != nil {
		return browserTreeSnapshot{}, err
	}
	return tree, nil
}

func findActionNodes(tree browserTreeSnapshot, placeholder string, buttonText string) (string, string, error) {
	var fillNode string
	var clickNode string
	for _, node := range tree.Nodes {
		actions := make(map[string]bool, len(node.Actions))
		for _, action := range node.Actions {
			actions[action] = true
		}
		if fillNode == "" && actions["fill"] && strings.EqualFold(node.Tag, "input") && node.Attributes["placeholder"] == placeholder {
			fillNode = node.PathID
			if fillNode == "" {
				fillNode = node.ID
			}
		}
		if clickNode == "" && actions["click"] && strings.EqualFold(node.Tag, "button") {
			haystack := node.Name + " " + node.Text + " " + node.Summary
			if strings.Contains(haystack, buttonText) {
				clickNode = node.PathID
				if clickNode == "" {
					clickNode = node.ID
				}
			}
		}
	}
	if fillNode == "" {
		return "", "", fmt.Errorf("could not find input node with placeholder %q", placeholder)
	}
	if clickNode == "" {
		return "", "", fmt.Errorf("could not find button node with text %q", buttonText)
	}
	return fillNode, clickNode, nil
}

func treeContainsMarker(tree browserTreeSnapshot, marker string) bool {
	for _, node := range tree.Nodes {
		haystacks := []string{node.Name, node.Text, node.Summary}
		for _, value := range haystacks {
			if strings.Contains(value, marker) {
				return true
			}
		}
	}
	return false
}

func assertNonEmptyRead(service *vfs.Service, target string) error {
	result, err := service.Read(target)
	if err != nil {
		return err
	}
	if len(result.Data) == 0 {
		return fmt.Errorf("read returned empty payload")
	}
	return nil
}

func sameTargetURL(actual string, expected string) bool {
	actual = strings.TrimSpace(actual)
	expected = strings.TrimSpace(expected)
	return actual == expected || strings.TrimSuffix(actual, "/") == strings.TrimSuffix(expected, "/")
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
