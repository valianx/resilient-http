/**
 * Unified test entry point for Node.js test runner.
 *
 * Importing all test files here forces them to run in the same process/worker,
 * preventing the Node 22 test runner from cancelling async tests in one file
 * when another file has already completed. Node 22's --test flag with multiple
 * file arguments spawns parallel workers that race to complete.
 */
import './backoff.test.ts';
import './error-extraction.test.ts';
import './jitter.test.ts';
import './retry-engine.test.ts';
import './signals.test.ts';
