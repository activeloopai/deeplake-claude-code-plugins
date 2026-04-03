---
name: deeplake-memory
description: Cloud-backed persistent memory for AI agents powered by DeepLake. Use when the user wants to save, recall, or manage shared memory that persists across sessions and machines.
allowed-tools: Read Bash
---

# DeepLake Memory

Cloud-backed memory that syncs across all agents via DeepLake.

## How it works

- **Save** memories to DeepLake cloud storage
- **Recall** relevant memories via keyword search
- **Share** memory across sessions, machines, and teammates in the same DeepLake org

## Usage

The mounted filesystem is at: `/Users/kamo/al-projects/testing-cli-installs/fuse_table1`

Read and write files there using standard filesystem operations. Files persist across sessions and are shared in real-time with all agents.

### File naming convention

`kamo_aghbalyan_activeloop_default_<filename>.json`

### Examples

```bash
# Save a memory
echo '{"key": "value"}' > /Users/kamo/al-projects/testing-cli-installs/fuse_table1/kamo_aghbalyan_activeloop_default_notes.json

# List memories
ls /Users/kamo/al-projects/testing-cli-installs/fuse_table1/

# Read a memory
cat /Users/kamo/al-projects/testing-cli-installs/fuse_table1/kamo_aghbalyan_activeloop_default_notes.json
```
