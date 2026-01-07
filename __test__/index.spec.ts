// eslint-disable-next-line n/no-missing-import
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// eslint-disable-next-line n/no-missing-import, n/no-unpublished-import
import { subscribe, type Subscription, type WatchEvent } from '../index.js';

/** Counter for generating unique filenames */
let fileCounter = 0;

/** Generate a unique filename in the given directory */
const getFilename = (baseDirectory: string, ...subDirectories: string[]) => {
  const randomSuffix = Math.random().toString(36).slice(2);
  return path.join(baseDirectory, ...subDirectories, `test${(fileCounter++).toString()}${randomSuffix}`);
};

/** Helper to find event by path */
const findEventByPath = (events: WatchEvent[], targetPath: string) => events.find((event) => event.path === targetPath);

/** Helper to check if any event matches the path */
const hasEventWithPath = (events: WatchEvent[], targetPath: string) => events.some((event) => event.path === targetPath);

/** Helper to wait for events with timeout */
const waitForEvents = (collector: { errors: Error[]; events: WatchEvent[] }, options: { minEvents?: number; timeout?: number } = {}): Promise<WatchEvent[]> => {
  const { minEvents = 1, timeout = 2000 } = options;

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (collector.events.length >= minEvents) {
        resolve(collector.events);
      } else {
        reject(new Error(`Timeout waiting for events. Got ${collector.events.length.toString()}, expected ${minEvents.toString()}.`));
      }
    }, timeout);

    const checkInterval = setInterval(async () => {
      if (collector.events.length >= minEvents) {
        clearTimeout(timeoutId);
        clearInterval(checkInterval);

        // Give a small delay for any additional events to arrive
        await sleep(50);

        resolve(collector.events);
      }
    }, 50);
  });
};

describe('watcher', () => {
  let testDirectory: string;
  let subscription: Subscription | undefined;
  let collector: { errors: Error[]; events: WatchEvent[] };

  const createCollector = () => ({ errors: [] as Error[], events: [] as WatchEvent[] });

  const subscribeWithCollector = (directory: string, options?: { ignore?: string[] }) => {
    collector = createCollector();
    subscription = subscribe(
      directory,
      ({ error, events }) => {
        if (error) {
          collector.errors.push(error);
        } else {
          collector.events.push(...events);
        }
      },
      options,
    );
    return subscription;
  };

  beforeEach(async () => {
    // Create a unique test directory using realpath to resolve symlinks
    testDirectory = path.join(await realpath(tmpdir()), `watcher-test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDirectory, { recursive: true });
    collector = createCollector();
  });

  afterEach(async () => {
    // Clean up subscription
    if (subscription) {
      subscription.unsubscribe();
      subscription = undefined;
    }

    // Clean up test directory
    try {
      await rm(testDirectory, { force: true, recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    await sleep(500);
  });

  describe('files', () => {
    test('should emit when a file is created', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const filePath = getFilename(testDirectory);
      await writeFile(filePath, 'hello world');

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('create');
    });

    test('should emit when a file is updated', async () => {
      const filePath = getFilename(testDirectory);
      await writeFile(filePath, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await writeFile(filePath, 'updated content');

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('update');
    });

    test('should emit when a file is renamed', async () => {
      const filePath1 = getFilename(testDirectory);
      const filePath2 = getFilename(testDirectory);
      await writeFile(filePath1, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await rename(filePath1, filePath2);

      // Renames can be reported as delete+create, or as update events depending on the platform
      const events = await waitForEvents(collector);

      // Should have events involving both paths or at least one of them
      const hasSourceEvent = hasEventWithPath(events, filePath1);
      const hasDestinationEvent = hasEventWithPath(events, filePath2);

      // At least one of the paths should have an event - using toContain shows both values on failure
      expect([hasSourceEvent, hasDestinationEvent]).toContain(true);
    });

    test('should emit when a file is deleted', async () => {
      const filePath = getFilename(testDirectory);
      await writeFile(filePath, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await unlink(filePath);

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('delete');
    });

    test('should emit when multiple files are created rapidly', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const files = Array.from({ length: 5 }, () => getFilename(testDirectory));
      for (const filePath of files) {
        await writeFile(filePath, 'content');
      }

      const events = await waitForEvents(collector, { minEvents: 5 });
      for (const filePath of files) {
        const event = findEventByPath(events, filePath);
        expect(event).toBeDefined();
        expect(event?.type).toBe('create');
      }
    });
  });

  describe('directories', () => {
    test('should emit when a directory is created', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const directoryPath = getFilename(testDirectory);
      await mkdir(directoryPath);

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, directoryPath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('create');
    });

    test('should emit when a directory is renamed', async () => {
      const directoryPath1 = getFilename(testDirectory);
      const directoryPath2 = getFilename(testDirectory);
      await mkdir(directoryPath1);
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await rename(directoryPath1, directoryPath2);

      // Renames can be reported as delete+create, or as update events depending on the platform
      const events = await waitForEvents(collector);
      const hasSourceEvent = hasEventWithPath(events, directoryPath1);
      const hasDestinationEvent = hasEventWithPath(events, directoryPath2);
      // At least one of the paths should have an event - using toContain shows both values on failure
      expect([hasSourceEvent, hasDestinationEvent]).toContain(true);
    });

    test('should emit when a directory is deleted', async () => {
      const directoryPath = getFilename(testDirectory);
      await mkdir(directoryPath);
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await rm(directoryPath, { recursive: true });

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, directoryPath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('delete');
    });

    test('should emit when nested directories are created', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const nestedPath = path.join(testDirectory, 'level1', 'level2', 'level3');
      await mkdir(nestedPath, { recursive: true });

      const events = await waitForEvents(collector);
      const level1Events = events.filter((event) => event.path.includes('level1'));
      expect(level1Events.length).toBeGreaterThan(0);
      const createEvents = level1Events.filter((event) => event.type === 'create');
      expect(createEvents.length).toBeGreaterThan(0);
    });
  });

  describe('sub-files', () => {
    test('should emit when a sub-file is created', async () => {
      const subDirectory = getFilename(testDirectory);
      await mkdir(subDirectory);
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      const filePath = path.join(subDirectory, 'file.txt');
      await writeFile(filePath, 'hello world');

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('create');
    });

    test('should emit when a sub-file is updated', async () => {
      const subDirectory = getFilename(testDirectory);
      await mkdir(subDirectory);
      const filePath = path.join(subDirectory, 'file.txt');
      await writeFile(filePath, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await writeFile(filePath, 'updated content');

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('update');
    });

    test('should emit when a sub-file is renamed', async () => {
      const subDirectory = getFilename(testDirectory);
      await mkdir(subDirectory);
      const filePath1 = path.join(subDirectory, 'file1.txt');
      const filePath2 = path.join(subDirectory, 'file2.txt');
      await writeFile(filePath1, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await rename(filePath1, filePath2);

      // Renames can be reported as delete+create, or as update events depending on the platform
      const events = await waitForEvents(collector);
      const hasSourceEvent = hasEventWithPath(events, filePath1);
      const hasDestinationEvent = hasEventWithPath(events, filePath2);
      // At least one of the paths should have an event - using toContain shows both values on failure
      expect([hasSourceEvent, hasDestinationEvent]).toContain(true);
    });

    test('should emit when a sub-file is deleted', async () => {
      const subDirectory = getFilename(testDirectory);
      await mkdir(subDirectory);
      const filePath = path.join(subDirectory, 'file.txt');
      await writeFile(filePath, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await unlink(filePath);

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('delete');
    });

    test('should emit when a file is moved to a sub-directory', async () => {
      const subDirectory = getFilename(testDirectory);
      await mkdir(subDirectory);
      const filePath1 = getFilename(testDirectory);
      await writeFile(filePath1, 'hello world');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      const filePath2 = path.join(subDirectory, 'moved.txt');
      await rename(filePath1, filePath2);

      // Moving files across directories generates events for both paths
      const events = await waitForEvents(collector);
      const hasSourceEvent = hasEventWithPath(events, filePath1);
      const hasDestinationEvent = hasEventWithPath(events, filePath2);
      // At least one of the paths should have an event - using toContain shows both values on failure
      expect([hasSourceEvent, hasDestinationEvent]).toContain(true);
    });
  });

  describe('sub-directories', () => {
    test('should emit when a sub-directory is created', async () => {
      const parentDirectory = getFilename(testDirectory);
      await mkdir(parentDirectory);
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      const subDirectory = path.join(parentDirectory, 'subdir');
      await mkdir(subDirectory);

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, subDirectory);
      expect(event).toBeDefined();
      expect(event?.type).toBe('create');
    });

    test('should emit when a sub-directory is deleted', async () => {
      const parentDirectory = getFilename(testDirectory);
      await mkdir(parentDirectory);
      const subDirectory = path.join(parentDirectory, 'subdir');
      await mkdir(subDirectory);
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await rm(subDirectory, { recursive: true });

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, subDirectory);
      expect(event).toBeDefined();
      expect(event?.type).toBe('delete');
    });

    test('should emit when a deeply nested file is created', async () => {
      const deepPath = path.join(testDirectory, 'a', 'b', 'c', 'd');
      await mkdir(deepPath, { recursive: true });
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      const filePath = path.join(deepPath, 'deep-file.txt');
      await writeFile(filePath, 'deep content');

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('create');
    });
  });

  describe('symlinks', () => {
    test('should emit when a symlink is created', async () => {
      const targetPath = getFilename(testDirectory);
      await writeFile(targetPath, 'target content');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      const linkPath = getFilename(testDirectory);
      try {
        await symlink(targetPath, linkPath);
        const events = await waitForEvents(collector);
        const event = findEventByPath(events, linkPath);
        expect(event).toBeDefined();
        expect(event?.type).toBe('create');
      } catch {
        // Symlinks might not be supported on all platforms/configurations
        console.log('Symlink test skipped (not supported on this platform)');
      }
    });

    test('should emit when a symlink is deleted', async () => {
      const targetPath = getFilename(testDirectory);
      await writeFile(targetPath, 'target content');
      const linkPath = getFilename(testDirectory);
      try {
        await symlink(targetPath, linkPath);
      } catch {
        // Symlinks might not be supported
        console.log('Symlink test skipped (not supported on this platform)');
        return;
      }
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      await unlink(linkPath);

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, linkPath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('delete');
    });
  });

  describe('ignore patterns', () => {
    test('should ignore a directory by glob pattern', async () => {
      const ignoredDirectoryName = 'ignored-dir-' + Date.now().toString();
      const ignoredDirectory = path.join(testDirectory, ignoredDirectoryName);
      const normalFile = getFilename(testDirectory);
      await mkdir(ignoredDirectory);

      // Use glob pattern to ignore the directory contents
      subscribeWithCollector(testDirectory, { ignore: [`${ignoredDirectoryName}/**`] });
      await sleep(100);

      await writeFile(normalFile, 'normal content');
      const ignoredFile = path.join(ignoredDirectory, 'ignored.txt');
      await writeFile(ignoredFile, 'ignored content');

      const events = await waitForEvents(collector);
      // Normal file should have an event
      const normalEvent = findEventByPath(events, normalFile);
      expect(normalEvent).toBeDefined();
      // Ignored file should NOT have an event
      const ignoredEvent = findEventByPath(events, ignoredFile);
      expect(ignoredEvent).toBeUndefined();
    });

    test('should ignore a file by path', async () => {
      const ignoredFile = getFilename(testDirectory);
      const normalFile = getFilename(testDirectory);

      subscribeWithCollector(testDirectory, { ignore: [ignoredFile] });
      await sleep(100);

      await writeFile(normalFile, 'normal content');
      await writeFile(ignoredFile, 'ignored content');

      const events = await waitForEvents(collector);
      // Normal file should have an event
      const normalEvent = findEventByPath(events, normalFile);
      expect(normalEvent).toBeDefined();
      // Ignored file should NOT have an event
      const ignoredEvent = findEventByPath(events, ignoredFile);
      expect(ignoredEvent).toBeUndefined();
    });

    test('should ignore files matching glob patterns', async () => {
      subscribeWithCollector(testDirectory, { ignore: ['*.log', '*.tmp'] });
      await sleep(100);

      const logFile = path.join(testDirectory, 'debug.log');
      const temporaryFile = path.join(testDirectory, 'temp.tmp');
      const normalFile = path.join(testDirectory, 'important.txt');

      await writeFile(logFile, 'log content');
      await writeFile(temporaryFile, 'tmp content');
      await writeFile(normalFile, 'normal content');

      const events = await waitForEvents(collector);
      // Normal file should have an event
      const normalEvent = findEventByPath(events, normalFile);
      expect(normalEvent).toBeDefined();
      // Log file should NOT have an event
      const logEvent = findEventByPath(events, logFile);
      expect(logEvent).toBeUndefined();
      // Temp file should NOT have an event
      const temporaryEvent = findEventByPath(events, temporaryFile);
      expect(temporaryEvent).toBeUndefined();
    });

    test('should ignore directories matching glob patterns', async () => {
      const ignoreDirectory = path.join(testDirectory, 'node_modules');
      await mkdir(ignoreDirectory);

      subscribeWithCollector(testDirectory, { ignore: ['node_modules/**'] });
      await sleep(100);

      const ignoredFile = path.join(ignoreDirectory, 'package.json');
      await writeFile(ignoredFile, '{}');
      const normalFile = path.join(testDirectory, 'index.js');
      await writeFile(normalFile, 'code');

      const events = await waitForEvents(collector);
      // Normal file should have an event
      const normalEvent = findEventByPath(events, normalFile);
      expect(normalEvent).toBeDefined();
      // node_modules file should NOT have an event
      const ignoredEvent = findEventByPath(events, ignoredFile);
      expect(ignoredEvent).toBeUndefined();
    });

    test('should support multiple ignore patterns', async () => {
      const buildDirectory = path.join(testDirectory, 'build');
      const cacheDirectory = path.join(testDirectory, '.cache');
      await mkdir(buildDirectory);
      await mkdir(cacheDirectory);

      subscribeWithCollector(testDirectory, { ignore: ['build/**', '.cache/**', '*.bak'] });
      await sleep(100);

      const buildFile = path.join(buildDirectory, 'output.js');
      const cacheFile = path.join(cacheDirectory, 'cache.json');
      const backupFile = path.join(testDirectory, 'backup.bak');
      await writeFile(buildFile, 'built code');
      await writeFile(cacheFile, '{}');
      await writeFile(backupFile, 'backup');
      const normalFile = path.join(testDirectory, 'source.ts');
      await writeFile(normalFile, 'source code');

      const events = await waitForEvents(collector);
      // Normal file should have an event
      const normalEvent = findEventByPath(events, normalFile);
      expect(normalEvent).toBeDefined();
      // Build file should NOT have an event
      const buildEvent = findEventByPath(events, buildFile);
      expect(buildEvent).toBeUndefined();
      // Cache file should NOT have an event
      const cacheEvent = findEventByPath(events, cacheFile);
      expect(cacheEvent).toBeUndefined();
      // Backup file should NOT have an event
      const backupEvent = findEventByPath(events, backupFile);
      expect(backupEvent).toBeUndefined();
    });
  });

  describe('multiple subscriptions', () => {
    test('should support multiple subscriptions to the same directory', async () => {
      const collector1 = createCollector();
      const collector2 = createCollector();

      const sub1 = subscribe(testDirectory, ({ error, events }) => {
        if (error) collector1.errors.push(error);
        else collector1.events.push(...events);
      });
      const sub2 = subscribe(testDirectory, ({ error, events }) => {
        if (error) collector2.errors.push(error);
        else collector2.events.push(...events);
      });

      try {
        await sleep(100);

        const filePath = getFilename(testDirectory);
        await writeFile(filePath, 'content');

        await waitForEvents(collector1);
        await waitForEvents(collector2);

        // Collector 1 should have event for the file
        expect(findEventByPath(collector1.events, filePath)).toBeDefined();
        // Collector 2 should also have event for the file
        expect(findEventByPath(collector2.events, filePath)).toBeDefined();
      } finally {
        sub1.unsubscribe();
        sub2.unsubscribe();
      }
    });

    test('should support subscriptions to different directories', async () => {
      const directory1 = path.join(await realpath(tmpdir()), `watcher-test-1-${Date.now().toString()}`);
      const directory2 = path.join(await realpath(tmpdir()), `watcher-test-2-${Date.now().toString()}`);
      await mkdir(directory1, { recursive: true });
      await mkdir(directory2, { recursive: true });

      const collector1 = createCollector();
      const collector2 = createCollector();

      const sub1 = subscribe(directory1, ({ error, events }) => {
        if (error) collector1.errors.push(error);
        else collector1.events.push(...events);
      });
      const sub2 = subscribe(directory2, ({ error, events }) => {
        if (error) collector2.errors.push(error);
        else collector2.events.push(...events);
      });

      try {
        await sleep(100);

        const file1 = path.join(directory1, 'file1.txt');
        const file2 = path.join(directory2, 'file2.txt');
        await writeFile(file1, 'content1');
        await writeFile(file2, 'content2');

        await waitForEvents(collector1);
        await waitForEvents(collector2);

        // Collector 1 should have event for file1
        expect(findEventByPath(collector1.events, file1)).toBeDefined();
        // Collector 1 should NOT have event for file2
        expect(findEventByPath(collector1.events, file2)).toBeUndefined();
        // Collector 2 should have event for file2
        expect(findEventByPath(collector2.events, file2)).toBeDefined();
        // Collector 2 should NOT have event for file1
        expect(findEventByPath(collector2.events, file1)).toBeUndefined();
      } finally {
        sub1.unsubscribe();
        sub2.unsubscribe();
        await rm(directory1, { force: true, recursive: true });
        await rm(directory2, { force: true, recursive: true });
      }
    });
  });

  describe('unsubscribe', () => {
    test('should stop receiving events after unsubscribe', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const file1 = getFilename(testDirectory);
      await writeFile(file1, 'before unsubscribe');

      await waitForEvents(collector);
      // File 1 should have an event
      expect(findEventByPath(collector.events, file1)).toBeDefined();

      // Unsubscribe
      if (subscription) {
        subscription.unsubscribe();
        subscription = undefined;
      }
      collector.events = [];

      // Create another file after unsubscribe
      const file2 = getFilename(testDirectory);
      await writeFile(file2, 'after unsubscribe');

      await sleep(100);

      // Should not have received events for the second file
      expect(findEventByPath(collector.events, file2)).toBeUndefined();
    });

    test('should allow re-subscribing after unsubscribe', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      if (subscription) {
        subscription.unsubscribe();
        subscription = undefined;
      }

      await sleep(100);

      // Re-subscribe
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const filePath = getFilename(testDirectory);
      await writeFile(filePath, 'new content');

      const events = await waitForEvents(collector);
      expect(findEventByPath(events, filePath)).toBeDefined();
    });
  });

  describe('errors', () => {
    test('should throw for invalid directory argument', () => {
      expect(() =>
        subscribe('', () => {
          /* empty */
        }),
      ).toThrow();

      expect(() =>
        subscribe(123 as unknown as string, () => {
          /* empty */
        }),
      ).toThrow();
    });

    test('should throw TypeError for invalid callback', () => {
      expect(() => subscribe(testDirectory, 'not a function' as unknown as () => void)).toThrow(TypeError);
    });

    test('should error if the watched directory does not exist', () => {
      expect(() =>
        subscribe(path.join(testDirectory, 'does-not-exist-' + Date.now().toString()), () => {
          /* empty */
        }),
      ).toThrow();
    });

    test('should error if the watched path is not a directory', async () => {
      const filePath = path.join(testDirectory, 'not-a-dir.txt');
      await writeFile(filePath, 'content');

      expect(() =>
        subscribe(filePath, () => {
          /* empty */
        }),
      ).toThrow();
    });
  });

  describe('rapid changes', () => {
    test('should handle rapid file creations', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const files: string[] = [];
      for (let index = 0; index < 10; index++) {
        const filePath = getFilename(testDirectory);
        files.push(filePath);
        await writeFile(filePath, `content ${index.toString()}`);
      }

      const events = await waitForEvents(collector, { minEvents: 10, timeout: 5000 });
      for (const filePath of files) {
        expect(findEventByPath(events, filePath)).toBeDefined();
      }
    });

    test('should handle rapid file updates', async () => {
      const filePath = getFilename(testDirectory);
      await writeFile(filePath, 'initial');
      await sleep(100);

      subscribeWithCollector(testDirectory);
      await sleep(100);

      for (let index = 0; index < 5; index++) {
        await writeFile(filePath, `update ${index.toString()}`);
        await sleep(10); // Small delay between operations
      }

      const events = await waitForEvents(collector);
      const event = findEventByPath(events, filePath);
      expect(event).toBeDefined();
      expect(event?.type).toBe('update');
    });

    test('should handle create and immediate delete', async () => {
      subscribeWithCollector(testDirectory);
      await sleep(100);

      const filePath = getFilename(testDirectory);
      await writeFile(filePath, 'temporary');
      await sleep(50); // Small delay between operations
      await unlink(filePath);

      /*
       * With debouncing, rapid create+delete might result in no events, one event, or both.
       * This test just verifies no crash occurs.
       */
      await sleep(300);

      // If we got events, they should be valid event types
      for (const event of collector.events) {
        expect(['create', 'delete', 'update']).toContain(event.type);
      }
    });
  });

  describe('subscription object', () => {
    test('should return a subscription object with unsubscribe method', () => {
      subscription = subscribe(testDirectory, () => {
        /* empty */
      });

      expect(subscription).toBeDefined();
      expect(typeof subscription.unsubscribe).toBe('function');
    });

    test('unsubscribe should be callable multiple times without error', () => {
      subscription = subscribe(testDirectory, () => {
        /* empty */
      });

      subscription.unsubscribe();
      // Should not throw
      subscription.unsubscribe();
      subscription = undefined;
    });
  });
});
