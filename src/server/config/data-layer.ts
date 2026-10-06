import "server-only";

import { createBigQueryClient } from "../adapters/bigquery/client";
import { createBigQueryGateway, sanitizeBigQueryError } from "../adapters/bigquery/gateway";
import { createQueryService } from "../data/query-service";
import { readBigQueryConfig } from "./bigquery";

export function createDataLayer() {
  const config = readBigQueryConfig();
  const gateway = createBigQueryGateway(createBigQueryClient(config), config);
  return createQueryService({ gateway, maximumBytesBilled: config.maximumBytesBilled, mapExecutionError: sanitizeBigQueryError });
}
