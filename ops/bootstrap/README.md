# Bootstrap recorder (`IO-01a` / `IO-01b`)

`preflight` is the only pre-runner recorder permitted before `IO-01c`. Its
executable SHA-256 is pinned in `preflight.sha256`; changing the executable
requires an explicit review and a new pin.

## Safety contract

- The target set is fixed to `nix`, `echova`, and `jiang-chenx`.
- Every probe is defined in the executable allowlist. There is no arbitrary
  command option.
- Remote probes use existing, host-key-checked SSH connections in batch mode.
  They explicitly require strict host-key checking against a fixed known-hosts
  file, record its hash/fingerprints, stream fixed commands, and never create a
  remote file.
- Probes are version, state, capability, listener, permission, clock, and disk
  queries only. They do not install packages, restart services, alter network
  policy, open ports, or change files.
- Raw stdout/stderr is streamed through an 8 MiB-per-stream bound, hashed in
  memory, and discarded. The bundle contains selected or redacted summaries
  plus full-output hashes; overflow terminates the probe and fails closed.
- Required categories use semantic validators. Snapshot completeness is kept
  separate from platform-spike blockers such as an unavailable encoder probe.
- The bundle embeds the exact recorder, pin, versioned schema, and Python
  runtime identity. A pre-seal sensitive-pattern scan must pass.
- A run uses a new `0700` directory and exclusive file creation, then seals the
  directory read-only. A rerun always gets a new run ID.

## Usage

```bash
./ops/bootstrap/preflight collect --nodes all
./ops/bootstrap/preflight verify-bundle evidence/bootstrap/io-01a/<run-id>
./ops/bootstrap/preflight record-toolchain
./ops/bootstrap/preflight verify-toolchain-bundle evidence/bootstrap/io-01b/<run-id>
```

`collect` returns exit code 0 only when every required category is represented
on all three nodes and each measured UTC offset is at most two seconds. Exit
code 2 means that the sealed bundle is valid but contains an environmental
blocker. Missing optional probe binaries are recorded rather than installed.

The resulting `index.json` status is deliberately
`bootstrap-complete-awaiting-IO-01c-formal-evidence`. It is not formal gate
evidence. `IO-01c` must import the bundle, verify its seal and recorder hash,
rerun stable snapshot fields through the formal runner, and bind the resulting
environment hash to later work packages.

## Bundle files

- `manifest.json`: recorder/allowlist hashes, operator, node set, and safety
  declaration.
- `recorder`, `recorder.sha256`, `bundle.schema.json`: exact provenance needed
  to revalidate an older run without treating it as the current recorder.
- `commands.jsonl`: append-style command records with timestamps, exit codes,
  durations, redacted summaries, and stdout/stderr hashes.
- `snapshot-<node>.json`: per-category normalized snapshot and clock gate.
- `index.json`: overall status and environment snapshot hash.
- `seal.json`: hashes of every preceding file and the aggregate bundle hash.

`verify-bundle` accepts only the fixed regular-file set, rejects traversal and
symlinks, validates schema/cross-file invariants, and reports seal integrity,
provenance completeness, current-recorder match, and trusted-recorder status as
separate properties. The bootstrap seal is not an operator signature; the
formal evidence signer is introduced by `IO-01c`.

`record-toolchain` is the IO-01b side of the same pinned recorder. It executes
only six local commands: lock validation, Go test/build, and web
typecheck/test/build. It embeds the exact toolchain lock, QG02 matrix,
CycloneDX SBOM, provenance schema, recorder, and pin. It never runs SSH or
changes a target node.
