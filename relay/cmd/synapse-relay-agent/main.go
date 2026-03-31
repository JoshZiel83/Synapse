package main

import (
	"os"

	"github.com/PekingSpades/Synapse/relay/internal/relayagentcmd"
)

var Version = "dev"

func main() {
	os.Exit(relayagentcmd.Run(Version, os.Args[1:]))
}
