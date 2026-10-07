import "server-only";

import { BigQuery } from "@google-cloud/bigquery";
import type { BigQueryConfig } from "../../config/bigquery";
import { readGoogleCredentials } from "../../config/google-credentials";

export function createBigQueryClient(config: BigQueryConfig): BigQuery {
  return new BigQuery({
    projectId: config.projectId,
    location: config.location,
    autoRetry: false,
    credentials: readGoogleCredentials(),
  });
}
