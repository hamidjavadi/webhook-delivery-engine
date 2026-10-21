import { runMigrations, type MigrationRunnerOptions } from '../storage/migrations/runner.js';

/** Options for ensuring database migrations finish before application startup. */
export type ApplicationBootstrapOptions = MigrationRunnerOptions & {
  /** Starts the scheduler, server, or embedded application after migrations complete. */
  readonly start: () => void | Promise<void>;
};

/**
 * Applies pending database migrations before starting application components.
 *
 * @param options - Migration connection, dialect, optional SQL directory, and start callback.
 * @returns A promise that resolves after migrations and application startup succeed.
 * @throws {@link MigrationError} when migration application fails; the start callback is not run.
 */
export async function bootstrapApplication(options: ApplicationBootstrapOptions): Promise<void> {
  const { start, ...migrationOptions } = options;
  await runMigrations(migrationOptions);
  await start();
}
