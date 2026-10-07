import { describe, expect, it } from "vitest";
import { DATASET_SCHEMA } from "./dataset-schema";
import { describeDatasetTopic } from "./dataset-catalog";
import { semanticSnapshotForQuery } from "./semantic-guide";

describe("on-demand dataset catalog", () => {
  it("finds listing tags hidden from the physical schema without doing warehouse work", () => {
    const result = describeDatasetTopic("view_item_list and item_list_name");
    expect(result.sections.map(section => section.id)).toContain("product_listing_and_promotion");
    const listing = result.sections.find(section => section.id === "product_listing_and_promotion");
    expect(listing?.content).toContain("item_list_name STRING");
    expect(listing?.content).toContain("view_item_list");
    expect(DATASET_SCHEMA).not.toContain("view_item_list");
    expect(result.note).toContain("does not read or count BigQuery");
  });

  it("returns a historical nested schema only when requested and labels tag inventory coverage", () => {
    const result = describeDatasetTopic("Which field has analytics_storage?");
    expect(result.sections.map(section => section.id)).toContain("physical_schema");
    const tags = describeDatasetTopic("parameter keys");
    expect(tags.sections.find(section => section.id === "event_parameter_keys")?.content)
      .toContain("2020-12-01 only");
  });

  it("does not infer absent metadata from an unmatched catalog topic", () => {
    expect(describeDatasetTopic("random obscure dimension").sections).toEqual([]);
  });

  it("stores compact relevant metric definitions instead of copying the full prompt", () => {
    const revenue = semanticSnapshotForQuery("SELECT SUM(ecommerce.purchase_revenue_in_usd) FROM events");
    const session = semanticSnapshotForQuery("SELECT ga_session_id FROM events");
    expect(revenue).toContain("Purchase revenue");
    expect(revenue).toContain("catalog ga4-sample-catalog-v2");
    expect(revenue).not.toContain("begin_checkout");
    expect(session).toContain("session is (available user_pseudo_id");
    expect(revenue.length).toBeLessThan(1_000);
  });
});
