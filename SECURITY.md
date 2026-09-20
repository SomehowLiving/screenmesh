# Security Policy

## Reporting a vulnerability

Please do **not** report suspected vulnerabilities through public GitHub issues, discussions, or social media.

Instead, contact the maintainers privately through the repository’s private security-advisory channel, if enabled. If that channel is not available, open a minimal public issue asking for a private contact method—do not include technical exploit details, pairing material, keys, or affected payloads.

Please include:

- A concise description of the issue and potential impact
- Affected component and version or commit
- Reproduction steps using safe, synthetic data
- Any proposed mitigation, if you have one

We will acknowledge a report as soon as practical, work on a fix privately where appropriate, and coordinate disclosure once users have a safe update path.

## Scope

Security-relevant reports include issues involving:

- Pairing, device identity, workspace membership, or revocation
- Encryption, signatures, ratchet/session handling, or replay protection
- Relay authorization or delivery to the wrong device
- Plaintext exposure to a relay, carrier, or unintended recipient
- Command or agent-task execution without explicit local approval
- Sensitive data retained unexpectedly after expiration or local deletion

## Please do not include secrets

Never send real pairing links, QR codes, workspace keys, private keys, ratchet state, authentication tokens, or other people’s object contents in a report. A safe proof of concept is enough.

## Supported versions

Security fixes are made against the latest version on the default branch. Pre-release and development builds should be treated as experimental.
