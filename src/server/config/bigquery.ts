import "server-only";

export type BigQueryConfig = {
  projectId: string;
  location: "US";
  maximumBytesBilled: string;
};

export function readBigQueryConfig(
  env: NodeJS.ProcessEnv = process.env,
): BigQueryConfig {
  const projectId = env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!projectId) {
    throw new Error("Set GOOGLE_CLOUD_PROJECT in .env.local to your query project ID.");
  }

  const location = env.BIGQUERY_LOCATION?.trim() || "US";
  if (location !== "US") {
    throw new Error("BIGQUERY_LOCATION must be US for the public GA4 sample.");
  }

  const maximumBytesBilled = env.BIGQUERY_MAX_BYTES_BILLED?.trim() || "1073741824";
  if (!/^[1-9]\d*$/.test(maximumBytesBilled)) {
    throw new Error("BIGQUERY_MAX_BYTES_BILLED must be a positive integer.");
  }

  return { projectId, location, maximumBytesBilled };
}
