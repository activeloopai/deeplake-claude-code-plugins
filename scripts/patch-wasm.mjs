#!/usr/bin/env node
/**
 * Patches the deeplake WASM glue code for Node.js v24+ MEMORY64 BigInt compatibility.
 * These patches exist in indra/scripts/build_wasm_node.py but weren't applied to npm v0.3.28.
 * Remove this script once the SDK publishes a fixed version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const wasmJs = join(__dir, "..", "node_modules", "deeplake", "wasm", "node", "deeplake_node.js");

let src;
try {
  src = readFileSync(wasmJs, "utf-8");
} catch {
  console.log("patch-wasm: deeplake not installed, skipping");
  process.exit(0);
}

// Skip if already patched
if (src.includes("idx=Number(idx);maxBytesToRead=Number(maxBytesToRead)")) {
  console.log("patch-wasm: already patched, skipping");
  process.exit(0);
}

const patches = [
  ["findStringEnd=(heapOrArray,idx,maxBytesToRead,ignoreNul)=>{var maxIdx=idx+maxBytesToRead",
   "findStringEnd=(heapOrArray,idx,maxBytesToRead,ignoreNul)=>{idx=Number(idx);maxBytesToRead=Number(maxBytesToRead);var maxIdx=idx+maxBytesToRead"],

  ['var UTF8ToString=(ptr,maxBytesToRead,ignoreNul)=>{if(!ptr)return"";var end=findStringEnd((growMemViews(),HEAPU8),ptr,maxBytesToRead,ignoreNul);return UTF8Decoder.decode((growMemViews(),HEAPU8).slice(ptr,end))',
   'var UTF8ToString=(ptr,maxBytesToRead,ignoreNul)=>{if(!ptr)return"";ptr=Number(ptr);if(maxBytesToRead!==undefined)maxBytesToRead=Number(maxBytesToRead);var end=findStringEnd((growMemViews(),HEAPU8),ptr,maxBytesToRead,ignoreNul);return UTF8Decoder.decode((growMemViews(),HEAPU8).slice(ptr,end))'],

  ['var AsciiToString=ptr=>{var str="";while(1){var ch=(growMemViews(),HEAPU8)[ptr++]',
   'var AsciiToString=ptr=>{ptr=Number(ptr);var str="";while(1){var ch=(growMemViews(),HEAPU8)[ptr++]'],

  ["var stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{",
   "var stringToUTF8Array=(str,heap,outIdx,maxBytesToWrite)=>{outIdx=Number(outIdx);"],

  ["var b=args/8;for",
   "var b=Number(args)/8;for"],

  ["allocateData(){var ptr=_malloc(24+Asyncify.StackSize);Asyncify.setDataHeader(ptr,ptr+24,Asyncify.StackSize)",
   "allocateData(){var ptr=Number(_malloc(24+Asyncify.StackSize));Asyncify.setDataHeader(ptr,ptr+24,Asyncify.StackSize)"],

  ["wasmMemory.grow(BigInt(pages))",
   "wasmMemory.grow(pages)"],
];

let count = 0;
for (const [old, rep] of patches) {
  if (src.includes(old)) {
    src = src.replaceAll(old, rep);
    count++;
  }
}

writeFileSync(wasmJs, src);
console.log(`patch-wasm: applied ${count} MEMORY64 BigInt patches`);
