# @dmemo/blob-spec

Canonical delta/checkpoint blob spec for dMemo (`dmemo/1`) — TypeScript
types plus encode/decode for the only thing dMemo ever encrypts and uploads
to 0G Storage. Language-agnostic by design (v1.1 target: Python parity).

Full format documentation: [`SPEC.md`](./SPEC.md).

## Install

```bash
npm install @dmemo/blob-spec
```

## Usage

```ts
import { encodeBlob, decodeBlob } from '@dmemo/blob-spec';
import type { Blob, DeltaBlob, CheckpointBlob, EnvelopeMeta } from '@dmemo/blob-spec';
```

This package has zero runtime dependencies and is consumed internally by
`@dmemo/core` (re-exported from its top-level `index.ts`, so most consumers
never need to depend on this package directly).
