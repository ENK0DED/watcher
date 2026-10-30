# @enk0ded/watcher

[![CI](https://github.com/ENK0DED/watcher/actions/workflows/CI.yml/badge.svg)](https://github.com/ENK0DED/watcher/actions/workflows/CI.yml)

> A high-performance file system watcher for Node.js, written in Rust and exposed via N-API bindings.

## Features

- **High Performance**: Uses native OS APIs (inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows)
- **Cross-Platform**: Works on Linux, macOS, and Windows
- **Event Debouncing**: Built-in debouncing to coalesce rapid file system changes
- **Glob Pattern Support**: Flexible ignore patterns using glob syntax
- **Recursive Watching**: Automatically watches all subdirectories
- **TypeScript First**: Full TypeScript support with comprehensive type definitions

## Installation

```bash
bun add @enk0ded/watcher
```

## Usage

```typescript
import { subscribe } from '@enk0ded/watcher';

// Start watching a directory
const subscription = subscribe(
  '/path/to/watch',
  ({ error, events }) => {
    if (error) {
      console.error('Watch error:', error);
      return;
    }

    for (const event of events) {
      console.log(`${event.type}: ${event.path}`);
    }
  },
  { ignore: ['node_modules', '*.log', '.git/**'] },
);

// Later, stop watching
subscription.unsubscribe();
```

## API

### `subscribe(directory, callback, options?)`

Subscribes to file system changes in a directory.

#### Parameters

- `directory` (`string`): The directory path to watch (must exist and be a directory)
- `callback` (`({ error, events }: { error?: Error; events: WatchEvent[] }) => void`): Function called with each batch of changes, or with an `error` if watching fails
- `options` (`WatchOptions`, optional): Configuration options
  - `ignore` (`string[]`, optional): Patterns to ignore (file paths or glob patterns). Each pattern is matched against both the path relative to `directory` and the absolute path, and ignoring a directory also ignores everything inside it.

#### Returns

`Subscription`: A subscription object with an `unsubscribe()` method. It keeps watching until `unsubscribe()` is called, even if no reference to it is kept.

#### Errors

`subscribe` throws a `TypeError` if an argument has the wrong type, and an `Error` if a value is invalid: an empty directory path, a directory that doesn't exist, a path that isn't a directory, or an invalid glob pattern. Errors that happen while watching are passed to the callback as `error`.

### Event Types

```typescript
type WatchEvent = {
  path: string; // Absolute path to the changed file/directory
  type: 'create' | 'update' | 'delete'; // Type of change
};
```

Renames and moves are reported as a `delete` of the old path and a `create` of the new one. Paths are based on the real path of the watched directory, with symlinks resolved (on macOS, for example, `/tmp` is reported as `/private/tmp`).

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.3.5
- [Rust](https://rustup.rs) >= 1.99.0
- Node.js >= 24

### Building

After `bun run build` command, you can see a `watcher.[darwin|win32|linux].node` file in project root. This is the native addon built from [lib.rs](./src/lib.rs).

```bash
# Install dependencies
bun install

# Build
bun run build

# Build in debug mode
bun run build:debug
```

### Testing

This package uses Bun's built in [Test runner](https://bun.com/docs/test).

```bash
bun test
```

### Linting and formatting

```bash
# Lint with Oxlint, fixing what can be fixed automatically
bun lint

# Format with Oxfmt and rustfmt
bun run format

# Type check
bun run typecheck
```

### CI

With GitHub Actions, each commit and pull request is built for every target in `napi.targets` and tested with Bun on Linux (glibc and musl, x64 and arm64) and Windows (x64).

### Release

The release action of this package releases multiple NPM packages for different platforms and adds them to `optionalDependencies` before releasing the main package.

Your package manager will choose which native package it should install automatically. The per-platform packages are generated in CI by `napi create-npm-dirs` and `napi artifacts`.

## Performance

This watcher is optimized for performance:

- Uses OS-native file watching APIs
- Events are debounced (100ms) to reduce callback overhead
- Glob patterns are pre-compiled at subscription time
- Each debounced batch of events is delivered to JavaScript in a single callback

## Release package

Packages are published with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is needed. On npmjs.com, add a trusted publisher (GitHub Actions, repository `ENK0DED/watcher`, workflow `CI.yml`) to `@enk0ded/watcher` and to each `@enk0ded/watcher-*` platform package.

When you want to release the package:

```bash
npm version [<newversion> | major | minor | patch | premajor | preminor | prepatch | prerelease [--preid=<prerelease-id>] | from-git]

git push
```

GitHub actions will do the rest job for you.

> WARN: Don't run `npm publish` manually.
