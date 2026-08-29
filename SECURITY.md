# Security

Do not open a public issue for vulnerabilities.

Use a [GitHub private security advisory](https://github.com/occcat/vibe-prompt-worker/security/advisories/new).

Never include any of the following in issues, pull requests, logs, or advisory attachments:

- `AUTH_VALUE` or derived bearer tokens
- `vaultPassword`
- Cloudflare API tokens or account IDs
- `.dev.vars`
- vault ciphertext, snapshots, or personal Worker URLs

This Worker is designed not to decrypt remote objects or snapshots. A report that requires plaintext vault contents is usually a client-side issue; still file it privately if disclosure could harm operators.
