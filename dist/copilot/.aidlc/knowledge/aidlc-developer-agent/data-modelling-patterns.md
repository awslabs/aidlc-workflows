# Data Modelling Patterns

Guidance for designing data models across relational and NoSQL databases, with emphasis on DynamoDB single-table design.

## Relational vs NoSQL — When to Choose

| Factor | Relational (RDS/Aurora) | NoSQL (DynamoDB) |
|--------|------------------------|------------------|
| Access patterns | Ad-hoc, complex joins | Known, predictable queries |
| Consistency | Strong ACID transactions | Eventual by default, optional strong |
| Scale model | Vertical (read replicas for reads) | Horizontal, automatic partitioning |
| Schema | Fixed, enforced at DB level | Flexible, enforced in application |
| Cost model | Instance-hours | Request-based (on-demand) or provisioned |

Choose relational when you need complex reporting, ad-hoc queries, or multi-table transactions. Choose DynamoDB when access patterns are well-defined, you need single-digit-ms latency at any scale, or you want zero operational overhead.

## Normalization Forms (Relational)

- **1NF**: Eliminate repeating groups; every column holds atomic values.
- **2NF**: Remove partial dependencies; every non-key column depends on the full primary key.
- **3NF**: Remove transitive dependencies; non-key columns depend only on the primary key, not on other non-key columns.
- **BCNF**: Every determinant is a candidate key.
- Normalize to 3NF for transactional systems. Denormalize selectively for read-heavy workloads (materialized views, read replicas).

## DynamoDB Single-Table Design

Single-table design stores multiple entity types in one table using overloaded partition and sort keys.

**Process**:
1. List all entities and their relationships (user, order, order-item, payment).
2. Document every access pattern with the query it must serve.
3. Design PK/SK patterns to satisfy those queries. Use prefixes: `PK=USER#123`, `SK=ORDER#2024-01-15#456`.
4. Use GSIs to support additional access patterns (inverted index, sparse index).

**Key Design Rules**:
- Partition key should distribute load evenly; avoid hot partitions.
- Sort key enables range queries and hierarchical data (`SK BEGINS_WITH 'ORDER#'`).
- Use composite sort keys for multi-level queries: `SK=STATUS#pending#DATE#2024-01-15`.
- Store item collections (1:N relationships) under the same partition key for transactional writes.

## Entity-Relationship Modelling

- Start with a conceptual ER diagram: entities, attributes, relationships (1:1, 1:N, M:N).
- For M:N relationships in DynamoDB, use an adjacency list pattern: the relationship itself is an item with `PK=ENTITY_A#id`, `SK=ENTITY_B#id`.
- For relational databases, use a join table with foreign keys to both sides.
- Document cardinality and optionality; they drive schema decisions.

## Index Design

**DynamoDB GSI/LSI**:
- GSI (Global Secondary Index): Different partition key; eventually consistent. Use for alternate query patterns.
- LSI (Local Secondary Index): Same partition key, different sort key; supports strong consistency. Must be defined at table creation.
- Limit GSIs to 5-8; each consumes additional write capacity.
- Use sparse indexes (only items with the indexed attribute appear) for filtered queries.

**Relational B-tree Indexes**:
- Index columns that appear in WHERE, JOIN, and ORDER BY clauses.
- Use composite indexes for multi-column queries; put the most selective column first.
- Avoid over-indexing; each index slows writes and consumes storage.
- Use EXPLAIN to validate query plans use the intended index.

## Schema Versioning

- Add a `schemaVersion` attribute to every item (DynamoDB) or a `schema_version` column (relational).
- Application code handles backward-compatible reads across versions.
- For relational, use migration tools (Flyway, Liquibase) with numbered, idempotent scripts.
- Never drop columns in production without a deprecation period; add new columns as nullable first.

## Data Migration Strategies

- **Dual-write**: Write to old and new stores simultaneously during transition. Complex but zero-downtime.
- **ETL batch migration**: Export, transform, load. Use for one-time moves with a maintenance window.
- **Change data capture (CDC)**: Stream changes from source to target (DynamoDB Streams, RDS event notifications). Best for live migrations.
- Always run migration with a dry-run/validation pass before committing. Compare row counts and checksums.
