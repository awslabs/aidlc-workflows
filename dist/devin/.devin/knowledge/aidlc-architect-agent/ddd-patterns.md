# Domain-Driven Design Patterns

## Purpose
DDD aligns software design with business reality. It provides patterns for modeling complex domains so that the code structure mirrors how the business thinks and operates.

## Strategic Design

### Bounded Contexts
A bounded context is an explicit boundary within which a domain model exists. The same real-world concept (e.g., "Customer") can have different meanings in different contexts.

**Example**:
- Sales context: Customer has leads, deals, revenue potential
- Support context: Customer has tickets, SLAs, satisfaction score
- Billing context: Customer has invoices, payment methods, credit limit

**Rules**:
- Each bounded context owns its data and logic — no shared database between contexts
- Communication between contexts uses well-defined interfaces (APIs, events)
- Each context can use different technology stacks and deployment strategies

### Context Mapping Patterns

| Pattern | Relationship | Use When |
|---------|-------------|----------|
| **Shared Kernel** | Two teams share a small common model | Teams are closely aligned and can coordinate changes |
| **Customer-Supplier** | Upstream supplies data, downstream consumes | Clear provider/consumer relationship between teams |
| **Conformist** | Downstream adopts upstream's model as-is | Upstream has no incentive to accommodate downstream needs |
| **Anti-Corruption Layer** | Downstream translates upstream's model | Integrating with legacy systems or external services |
| **Open Host Service** | Upstream publishes a well-defined protocol | Multiple consumers need access to a context's capabilities |
| **Published Language** | Shared interchange format (e.g., JSON schema) | Cross-context communication needs a stable contract |
| **Separate Ways** | No integration | The cost of integration exceeds the benefit |

### Anti-Corruption Layer (ACL)
When integrating with an external or legacy system whose model does not match yours:
```
Your Domain Model <-> ACL (translates) <-> External System Model
```
The ACL isolates your clean model from the external system's concepts. If the external system changes, only the ACL needs updating.

## Tactical Design

### Entities
Objects defined by their identity, not their attributes. Two customers with the same name are different customers if they have different IDs.
- Have a unique identifier that persists across state changes
- Mutable — their state changes over time
- Example: User, Order, Account

### Value Objects
Objects defined by their attributes, not their identity. Two Money objects with the same amount and currency are interchangeable.
- Immutable — create a new instance instead of modifying
- No identity — equality is based on all attributes
- Example: EmailAddress, Money, DateRange, Address
- Prefer value objects over primitives (an email is not just a string)

### Aggregates
A cluster of entities and value objects treated as a single unit for data changes.

**Rules**:
- Each aggregate has exactly one **aggregate root** — the only entity external code can reference
- All changes to the aggregate go through the root (enforces invariants)
- Transactions should not span multiple aggregates
- Reference other aggregates by ID, not by object reference
- Keep aggregates small — large aggregates cause contention and performance issues

**Example**:
```
Order (Aggregate Root)
  ├── OrderLine (Entity, only accessible through Order)
  ├── ShippingAddress (Value Object)
  └── OrderStatus (Value Object)
```

External code calls `order.addItem(product, quantity)` — never modifies OrderLine directly.

### Domain Events
Record something meaningful that happened in the domain. Events are past-tense facts.

**Naming**: `[Entity][PastTenseVerb]` — OrderPlaced, PaymentReceived, InventoryDepleted

**Structure**:
- Event ID (unique)
- Timestamp (when it occurred)
- Aggregate ID (which aggregate produced it)
- Payload (relevant data at the time of the event)

**Uses**:
- Trigger side effects in other bounded contexts (eventual consistency)
- Build audit trails and event sourcing
- Enable loose coupling — publishers do not know about subscribers

### Repository Pattern
Provides a collection-like interface for accessing aggregates, hiding persistence details from the domain layer.

**Interface** (defined in the domain layer):
```
interface OrderRepository {
  findById(id: OrderId): Order | null
  save(order: Order): void
  findByCustomer(customerId: CustomerId): Order[]
}
```

**Rules**:
- One repository per aggregate root (not per entity or table)
- Repository interface lives in the domain layer; implementation lives in infrastructure
- Repositories return fully constituted aggregates, not partial data
- Do not put query logic in repositories — use separate read models for complex queries

## Event Storming

A collaborative workshop technique for discovering domain events, commands, and aggregates.

### Process
1. **Gather**: Domain experts + developers in a room with unlimited sticky notes
2. **Domain Events** (orange): Brainstorm everything that happens in the domain (past tense)
3. **Commands** (blue): What triggers each event? (imperative: "Place Order")
4. **Actors** (yellow): Who or what issues the command? (User, System, Scheduler)
5. **Aggregates** (pale yellow): Group events around the entity they affect
6. **Bounded Contexts**: Draw boundaries around related aggregate clusters
7. **Policies** (purple): Automated reactions ("When OrderPlaced, then ReserveInventory")

### Output
A visual map of the domain that reveals:
- Core business processes and their interactions
- Natural bounded context boundaries
- Integration points between contexts
- Hot spots (areas of complexity, contention, or confusion)

## Design Heuristics
- If two concepts change for different reasons, they belong in different bounded contexts
- If you need a transaction across two aggregates, reconsider the aggregate boundaries
- Start with larger aggregates and split when you encounter contention or performance issues
- Domain events are the primary integration mechanism between bounded contexts
- Ubiquitous language: use the same terms in code, documentation, and conversation with domain experts
