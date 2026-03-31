//go:build !windows

package main

import "os/exec"

func configureAgentCommand(cmd *exec.Cmd) {}
