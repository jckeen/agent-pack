> **Historical** — point-in-time record (2026-06-12). Do not act on this.

# Data Models and API

The MVP can use static seed data. These models define the future registry backend.

## Data models

### User

```ts
type User = {
  id: string;
  name: string;
  email: string;
  handle: string;
  avatarUrl?: string;
  role: "user" | "publisher_admin" | "registry_admin";
  createdAt: Date;
  updatedAt: Date;
};
```

### Publisher

```ts
type Publisher = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  website?: string;
  verified: boolean;
  verificationStatus: "unverified" | "pending" | "verified" | "revoked";
  ownerUserId: string;
  createdAt: Date;
};
```

### Pack

```ts
type Pack = {
  id: string;
  publisherId: string;
  slug: string;
  name: string;
  description: string;
  latestVersionId?: string;
  visibility: "public" | "private" | "unlisted";
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};
```

### PackVersion

```ts
type PackVersion = {
  id: string;
  packId: string;
  version: string;
  manifestYaml: string;
  manifestJson: unknown;
  readme: string;
  changelog?: string;
  license?: string;
  checksum: string;
  signature?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  reviewStatus: "unreviewed" | "automated_scan_passed" | "manual_reviewed" | "verified" | "flagged" | "blocked";
  publishedAt: Date;
};
```

### Atom

```ts
type Atom = {
  id: string;
  packVersionId: string;
  atomKey: string;
  type: string;
  name: string;
  description: string;
  path: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  manifestJson: unknown;
};
```

### Compatibility

```ts
type Compatibility = {
  id: string;
  packVersionId: string;
  target: "claude-code" | "codex" | "cursor" | "chatgpt" | "generic";
  status: "supported" | "partial" | "experimental" | "unsupported";
  notes?: string;
  minVersion?: string;
};
```

### InstallProfile

```ts
type InstallProfile = {
  id: string;
  packVersionId: string;
  name: string;
  description: string;
  includedAtoms: string[];
  excludedAtoms: string[];
  policyJson?: unknown;
};
```

### PermissionDeclaration

```ts
type PermissionDeclaration = {
  id: string;
  packVersionId?: string;
  atomId?: string;
  category: string;
  scope?: string[];
  required: boolean;
  description: string;
};
```

### SecurityScan

```ts
type SecurityScan = {
  id: string;
  packVersionId: string;
  status: "passed" | "warning" | "failed";
  riskLevel: "low" | "medium" | "high" | "critical";
  findings: Array<{
    code: string;
    message: string;
    severity: string;
    atomId?: string;
  }>;
  scannerVersion: string;
  createdAt: Date;
};
```

### Review

```ts
type Review = {
  id: string;
  packId: string;
  userId: string;
  rating: number;
  title?: string;
  body?: string;
  createdAt: Date;
};
```

### Download

```ts
type Download = {
  id: string;
  packVersionId: string;
  target?: string;
  profile?: string;
  userId?: string;
  ipHash?: string;
  createdAt: Date;
};
```

### AuditEvent

```ts
type AuditEvent = {
  id: string;
  actorUserId?: string;
  publisherId?: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
};
```

### InstallPlan

```ts
type InstallPlan = {
  id: string;
  packVersionId: string;
  target: string;
  profile: string;
  selectedAtoms: string[];
  riskLevel: string;
  permissionsJson: unknown;
  filePlanJson: unknown;
  warningsJson: unknown;
  createdAt: Date;
};
```

### Adapter

```ts
type Adapter = {
  id: string;
  target: string;
  version: string;
  status: "stable" | "experimental" | "deprecated";
  capabilities: string[];
};
```

### Dependency

```ts
type Dependency = {
  id: string;
  packVersionId: string;
  kind: "pack" | "atom" | "tool" | "mcp_server" | "runtime" | "platform";
  name: string;
  versionRange?: string;
  optional: boolean;
};
```

## API routes

### Public pack routes

```http
GET /api/packs
GET /api/packs/search?q=
GET /api/packs/:publisher/:slug
GET /api/packs/:publisher/:slug/versions
GET /api/packs/:publisher/:slug/versions/:version
GET /api/packs/:publisher/:slug/atoms
GET /api/packs/:publisher/:slug/atoms/:atomId
```

### Adapter routes

```http
GET /api/adapters
GET /api/adapters/:target
```

### Validation and planning

```http
POST /api/validate/manifest
POST /api/plan
POST /api/export
```

### Publishing

```http
POST /api/packs
POST /api/packs/:publisher/:slug/publish
POST /api/packs/:publisher/:slug/fork
```

### Reviews

```http
GET /api/packs/:publisher/:slug/reviews
POST /api/packs/:publisher/:slug/reviews
```

### Downloads

```http
GET /api/packs/:publisher/:slug/download
GET /api/packs/:publisher/:slug/export/:target
```
