# Provenance contract

`statement.schema.json` is the IO-01b SLSA/in-toto envelope skeleton. A release
build must emit one statement per binary, image, and immutable web artifact.
Each subject is addressed by SHA-256 and binds the source commit/tree,
`toolchain.lock.json` hash, builder identity, invocation, start/end UTC, and all
resolved inputs. IO-01c validates the statement and signs its enclosing evidence
index; this directory contains no signing key and IO-01b claims no signature.

