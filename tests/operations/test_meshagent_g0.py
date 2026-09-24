from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
LINUX = ROOT / "deploy" / "g0" / "meshagent" / "linux"
WINDOWS = ROOT / "deploy" / "g0" / "meshagent" / "windows"
CONTROL_PLANE_UNIT = ROOT / "deploy" / "g0" / "meshcentral" / "screen-control-meshcentral-g0.service"


class MeshAgentG0Tests(unittest.TestCase):
    def test_linux_unit_is_firewall_gated(self) -> None:
        unit = (LINUX / "screen-control-meshagent.service").read_text()
        self.assertIn("ExecStartPre=/usr/local/libexec/screen-control-meshagent-firewall apply", unit)
        self.assertIn("ExecStopPost=/usr/local/libexec/screen-control-meshagent-firewall remove", unit)
        self.assertLess(unit.index("ExecStartPre="), unit.index("ExecStart=/opt/screen-control/meshagent/meshagent"))
        self.assertNotIn("Environment=", unit)

    def test_linux_memory_budget_covers_agent_process_tree(self) -> None:
        unit = (LINUX / "screen-control-meshagent.service").read_text()
        for setting in ("MemoryAccounting=yes", "MemoryHigh=infinity", "MemoryMax=768M", "MemorySwapMax=128M", "OOMPolicy=kill", "Restart=always"):
            self.assertIn(setting, unit)
        suite = (ROOT / "deploy/g0/suite/screen-control-suite.service").read_text()
        for setting in ("GOMEMLIMIT=128MiB", "MemoryHigh=192M", "MemoryMax=256M", "MemorySwapMax=64M", "OOMPolicy=kill"):
            self.assertIn(setting, suite)

    def test_stall_override_matches_fresh_install_and_preserves_hard_budget(self) -> None:
        unit = (LINUX / "screen-control-meshagent.service").read_text()
        override = (LINUX / "60-stall-recovery.conf").read_text()
        for line in override.splitlines():
            if "=" in line and not line.startswith("#"):
                self.assertIn(line, unit)
        for setting in ("MemoryMax=", "MemorySwapMax=", "ExecStart=", "ExecStartPre="):
            self.assertNotIn(setting, override)
        for setting in ("TimeoutStopSec=15s", "KillMode=control-group", "SendSIGKILL=yes",
                        "StartLimitIntervalSec=300", "StartLimitBurst=3"):
            self.assertIn(setting, override)

    def test_linux_firewall_is_cgroup_scoped_and_fail_closed(self) -> None:
        script = (LINUX / "meshagent-firewall").read_text()
        self.assertIn("--path \"$CGROUP\"", script)
        self.assertIn('SCREEN_CONTROL_REGISTERED_IPS', script)
        self.assertIn('"$IPT" -w -A "$CHAIN" -j REJECT', script)
        self.assertIn('"$IP6T" -w -A "$CHAIN" -j REJECT', script)
        self.assertIn("sha256sum -c meshagent.sha256", script)
        self.assertNotIn("0.0.0.0/0 -j ACCEPT", script)
        self.assertNotIn("::/0 -j ACCEPT", script)

    def test_linux_rollback_disables_service_and_removes_only_owned_state(self) -> None:
        script = (LINUX / "meshagent-rollback").read_text()
        self.assertIn("disable --now screen-control-meshagent.service", script)
        self.assertIn("screen-control-meshagent-firewall remove", script)
        self.assertIn("# screen-control-g0", script)
        self.assertNotIn("iptables -F", script)

    def test_pinned_linux_agent_hash(self) -> None:
        checksums = [line.split() for line in (LINUX / "meshagent.sha256").read_text().splitlines()]
        self.assertEqual(checksums[0], ["891da8d32d0fbfec933b7ca5aa64b27650c05531a772f993601f20ae7c2c0a3b", "meshagent"])
        self.assertEqual(checksums[1], ["fbc4b76433287ae9b07e673be0eb8e978968018c97c8e51a639ce410b2eb5ca0", "meshagent.msh"])

    def test_windows_guard_is_program_address_and_adapter_scoped(self) -> None:
        script = (WINDOWS / "meshagent-guard.ps1").read_text()
        self.assertIn("07800ec6600eb837216dbd15adb497d5a21346dddf1a5f0742d31097f0df83f7", script)
        self.assertIn('-Program $AgentPath', script)
        self.assertIn('-Service $service.Name', script)
        self.assertIn('sidtype $service.Name unrestricted', script)
        self.assertIn('Get-NetFirewallServiceFilter', script)
        self.assertIn('"PrepareHost" { Set-HostMapping }', script)
        self.assertIn("for ($attempt = 1; $attempt -le 20; $attempt++)", script)
        self.assertIn("[System.IO.File]::WriteAllLines", script)
        self.assertIn('"127.0.0.1 localhost"', script)
        self.assertIn('"::1 localhost"', script)
        self.assertIn('-InterfaceAlias "Tailscale"', script)
        self.assertIn('SCREEN_CONTROL_REGISTERED_IPS', script)
        self.assertIn('ConvertFrom-IPv4Number ($number - 1)', script)
        self.assertIn('$BlockedIpv6 = @("::/1", "8000::/1")', script)
        self.assertIn('-RemoteAddress $BlockedIpv6', script)
        self.assertIn("Start-Sleep -Seconds 2", script)
        self.assertIn("Stop-Service", script)
        self.assertIn(".PathName.Replace('\\\\', '\\')", script)

    def test_windows_installer_registers_system_watchdog(self) -> None:
        script = (WINDOWS / "install-watchdog.ps1").read_text()
        self.assertIn('-User "SYSTEM" -RunLevel Highest', script)
        self.assertIn("-Mode Boot", script)
        self.assertIn("Start-ScheduledTask", script)

    def test_windows_deploy_arms_rollback_before_install(self) -> None:
        script = (WINDOWS / "deploy.ps1").read_text()
        self.assertLess(script.index("Register-ScheduledTask -TaskName $RollbackTask"), script.index("-Mode Preblock"))
        self.assertLess(script.index("-Mode Preblock"), script.index("-fullinstall"))
        self.assertLess(script.index("-Mode Apply"), script.index("-StartupType Manual"))
        self.assertNotIn("-StartupType Automatic", script)
        self.assertIn("catch {", script)
        self.assertIn("-Mode Rollback", script)

    def test_control_plane_boot_unit_preserves_isolated_volumes(self) -> None:
        unit = CONTROL_PLANE_UNIT.read_text()
        self.assertIn("Requires=docker.service tailscaled.service", unit)
        self.assertIn("compose --project-directory ${SCREEN_CONTROL_PROJECT_ROOT}/deploy/spike/meshcentral -f ${SCREEN_CONTROL_PROJECT_ROOT}/deploy/spike/meshcentral/compose.yaml up --no-build", unit)
        self.assertIn("compose --project-directory ${SCREEN_CONTROL_PROJECT_ROOT}/deploy/spike/meshcentral -f ${SCREEN_CONTROL_PROJECT_ROOT}/deploy/spike/meshcentral/compose.yaml down", unit)
        self.assertNotIn("--volumes", unit)
        self.assertNotIn("build", unit.replace("--no-build", ""))


if __name__ == "__main__":
    unittest.main()
