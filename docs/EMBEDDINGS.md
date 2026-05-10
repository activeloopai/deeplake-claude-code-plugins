# Embeddings (semantic search)

Hivemind can run a local embedding daemon (nomic-embed-text-v1.5, ~130 MB) so that `Grep` over `~/.deeplake/memory/` uses hybrid semantic + lexical ranking instead of pure BM25. This is **off by default** — the daemon depends on `@huggingface/transformers`, which pulls onnxruntime-node and sharp (~600 MB total with native binaries). Shipping that with every agent install would 60× the install size for a feature most users don't need.

## Install

```bash
hivemind embeddings install
```

This installs `@huggingface/transformers` **once** into a shared directory (`~/.hivemind/embed-deps/`) and symlinks every detected agent's plugin to it, so the 600 MB cost is paid one time regardless of how many agents you have wired up. Re-run the same command after installing a new agent and the new symlink is added (the npm install is skipped because it's cached).

Or do it in one shot at install time:

```bash
hivemind install --with-embeddings           # all detected agents
hivemind <agent> install --with-embeddings   # a single agent
```

## Other commands

```bash
hivemind embeddings status              # show shared deps + per-agent state
hivemind embeddings uninstall           # remove the per-agent symlinks
hivemind embeddings uninstall --prune   # also delete the shared dir (~600 MB)
```

Restart your agents after enabling. From the next session, captured messages and AI-generated summaries will include a 768-dim embedding, and semantic recall queries will route through the local daemon (the nomic model is downloaded on first use and cached in `~/.cache/huggingface/`).

## Lexical-only fallback

If `@huggingface/transformers` is **not** present, Hivemind silently degrades to lexical-only mode:

- ✅ Capture continues; rows still land in Deeplake.
- ✅ `Grep` still works via BM25 / `ILIKE` matching on text columns.
- ⚪ The `message_embedding` / `summary_embedding` columns stay `NULL`.
- ⚪ The hook log notes `embeddings: no-transformers` once at session start.

You can also force lexical-only mode explicitly with `HIVEMIND_EMBEDDINGS=false` (useful for CI or air-gapped environments).
