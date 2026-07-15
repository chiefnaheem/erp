import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Applies erp-sync's own SQL migrations for the `erp_raw` schema.
 *
 * We deliberately do NOT use `prisma migrate` here. The main Viju API owns the
 * migration history for `public`, and running Prisma's migrator from this app
 * would have it diff the whole database — including tables it does not own —
 * and happily propose dropping them. Plain SQL, applied additively, keeps the
 * blast radius to `erp_raw` and nothing else.
 */
@Injectable()
export class RawMigrator implements OnModuleInit {
  private readonly logger = new Logger(RawMigrator.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.apply();
  }

  async apply(): Promise<string[]> {
    const dir = join(__dirname, '..', '..', 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied: string[] = [];

    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');

      // Postgres prepared statements accept ONE command each, so the file has to
      // be executed statement by statement — sending it whole fails with a
      // syntax error. Every statement is CREATE ... IF NOT EXISTS, so re-running
      // the file is a no-op.
      //
      // $executeRawUnsafe is required because this is DDL from a trusted local
      // file, not user input — Prisma cannot parameterise DDL.
      for (const statement of splitStatements(sql)) {
        await this.prisma.$executeRawUnsafe(statement);
      }

      applied.push(file);
      this.logger.log(`applied ${file}`);
    }

    return applied;
  }
}

/** Split a .sql file into executable statements, dropping comments and blanks. */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
