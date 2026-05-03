/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Encode/decode utf-8 <-> base64.
//
// Internal-fork hardening (_security-review/02-supply-chain-audit.md):
// upstream pulled in crypto-js (deprecated by author since 2023) for
// nothing more than base64 transcoding. We replace with the universal
// btoa/atob + TextEncoder/TextDecoder primitives, which are available in
// every JS environment we target (Electron main, Electron renderer with
// or without nodeIntegration, Node 22, modern browsers via the extension
// API). No external dependency needed.

/**
 * Computes utf-8 from base64
 * @param data A Base64 encoded string
 * @returns The original utf-8 string
 */
function decode(data: string): string {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Computes base64 from utf-8
 * @param data A normal string
 * @returns A base64 encoded version
 */
function encode(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i] as number);
  }
  return btoa(bin);
}

export const base64 = {
  encode,
  decode,
};
