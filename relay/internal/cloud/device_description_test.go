package cloud

import "testing"

func TestFormatRelayDescriptionIncludesDeviceTypeAndSystemVersion(t *testing.T) {
	got := formatRelayDescription("desktop_computer", "windows", "Windows 11 24H2")
	want := "Desktop computer running Windows 11 24H2"
	if got != want {
		t.Fatalf("formatRelayDescription() = %q, want %q", got, want)
	}
}

func TestFormatRelayDescriptionFallsBackToPlatformName(t *testing.T) {
	got := formatRelayDescription("desktop_computer", "linux", "")
	want := "Desktop computer running Linux"
	if got != want {
		t.Fatalf("formatRelayDescription() = %q, want %q", got, want)
	}
}

func TestHumanizeDeviceType(t *testing.T) {
	if got := humanizeDeviceType("virtual_machine"); got != "Virtual machine" {
		t.Fatalf("humanizeDeviceType() = %q, want %q", got, "Virtual machine")
	}
	if got := humanizeDeviceType("wearable_device"); got != "Wearable Device" {
		t.Fatalf("humanizeDeviceType() = %q, want %q", got, "Wearable Device")
	}
}
