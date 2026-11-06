# 技術環境ドキュメントの書き方

技術環境ドキュメントは、**プロジェクトをどう作るか**を記します。使うべき言語、フレームワーク、クラウドサービス、セキュリティルール、テスト、そして使ってはならないものです。これは
[ビジョンドキュメント](vision-document-guide.md)の技術面の対になるもので、Construction のステージが参照する資料です。

これがないと、設計と構築のステージは、選択のたびにあなたに尋ねるか、あなたが後で変えなければならないデフォルトを選んでしまいます。理由を添えた許可リストと禁止リストが、エージェントの推測を止めます。

---

## AI-DLC での置き場所

ビジョンドキュメントは最初の依頼に入れます。技術環境
ドキュメントは、すべてのステージが読む場所、つまりあなたの space のチーム knowledge に置きます。

1. 次の場所に保存します。
   `aidlc/spaces/<space>/knowledge/aidlc-shared/technical-environment.md`
   (他を作っていなければ space 名は `default` です)。`aidlc-shared/` の中の Markdown
   ファイルはすべて、どのステージのコンテキストにも含まれます。
   [Knowledge](../08-knowledge.md) の章では、このフォルダーを
   `aidlc/knowledge/aidlc-shared/` と呼んでいます。
2. その内容はすべて `aidlc-shared/` に置いてください。セキュリティ、テスト、クラウドの標準は、異なるエージェントが率いるステージが読みます (たとえば Code Generation は developer エージェントとして動きます)。エージェント自身のフォルダーは、そのエージェントが作業している間だけ読まれます。エージェントフォルダーは、一つのエージェントだけが必要とする資料にのみ使ってください。フォルダー名については
   [Adding Company Standards](../08-knowledge.md#adding-company-standards)
   を参照してください。
3. 決して破ってはならない少数のルール (禁止ライブラリ、必須バージョン) は、
   `aidlc/spaces/<space>/memory/project.md` にも置きます。チームが動かすすべてのプロジェクトに当てはまるなら `team.md` に置きます。memory
   ファイルは、すべてのステージが適用するルールです。
   [Rules and the Learning Loop](../09-rules-and-the-learning-loop.md) を参照してください。

これは、その作業の最初の `/aidlc` の前に行ってください。Inception の初めで、プランに
Practices Discovery が含まれるとき、それはチームの進め方を尋ねます。新規プロジェクトでは、このドキュメントにすでにある答えをすぐに確認できます。

---

## 短い版

```text
1. Language and version
2. Package manager
3. Web framework (if any)
4. Cloud provider and deployment model, or "local only"
5. Test framework
6. Prohibited libraries and services, as a table: prohibited | reason | use instead
7. Security basics: how users sign in, how input is validated, where secrets live
8. Example code: one short example each of a typical endpoint, function and test
```

項目 6 では、理由と代替が重要です。それらがないと、エージェントは禁止には従いますが、よい代用を判断できません。

項目 8 では、たとえ一つか二つの短い例でも、Code Generation に、自分で編み出すのではなく従うべきパターンを与えます。これは、基本を超えて加えるもののうち、最も役立つものです。

### 既存コードベースでの作業向け

```text
1. Existing stack: language, framework, database, infrastructure, with versions
2. What never changes: services, schemas, contracts, configuration no piece of work may touch
3. Prohibited patterns: libraries or approaches that conflict with the existing code
4. Security basics: how sign-in and secrets work in the existing system
5. Example code taken from the existing codebase
```

例は実際のファイルから取ってください。そうすれば新しいコードがなじんで見えます。
Reverse Engineering もコードを読みますが、どのパターンを残したいか、どれから離れようとしているかを判別できません。

この作業が加えたり変えたりするもの、そしてこの作業だけが触れずに残すべきものは、
[ビジョンノート](vision-document-guide.md#for-work-on-an-existing-codebase)に書きます。このドキュメントは space に残り、後のすべての作業が読みます。

プロジェクトが新規か既存かは、このドキュメントではなく、プロジェクトフォルダーのコードから決まります。AI-DLC が既存のプロジェクトを新規と呼んだら、依頼でそう伝えるか、`/aidlc --project-type brownfield` で始めてください。

---

## 完全な構成

各セクションを、プロジェクトの種類で印付けします。新規プロジェクトは **(New)**、既存コードベースの作業は **(Existing)**、両方は **(Both)** です。

### 1. Project Technical Summary (Both)

```markdown
## Project Technical Summary

- **Project name**: [Name]
- **Project type**: [New / Existing codebase]
- **Runtime environment**: [Cloud / On-premises / Hybrid]
- **Cloud provider**: [AWS / Azure / GCP / Multi-cloud / None]
- **Deployment model**: [Serverless / Containers / VMs / Hybrid]
- **Team size and key skills**: [Number, experience relevant to the choices]
```

### 2. Programming Languages (Both)

```markdown
## Programming Languages

### Required
| Language | Version | Purpose | Reason |
|----------|---------|---------|--------|
| TypeScript | 5.x | Backend services, infrastructure code | Team expertise, type safety |

### Permitted with justification
| Language | When it may be used |
|----------|---------------------|
| Go | High-throughput services where latency is critical |

### Prohibited
| Language | Reason |
|----------|--------|
| PHP | No team expertise, not the platform direction |
```

既存コードベースでは、すでに使われている言語と、それぞれの方向 (維持、アップグレード、移行) を加えてください。

### 3. Frameworks and Libraries (Both)

```markdown
## Frameworks and Libraries

### Required
| Framework or library | Version | Area | Reason |
|----------------------|---------|------|--------|
| React | 18.x | Frontend UI | Organisational standard |
| Jest | 29.x | Unit tests | One test runner across projects |

### Preferred when the need arises
| Library | Purpose | Use when |
|---------|---------|----------|
| Zod | Runtime validation | Any external input or API payload |
| Pino | Structured logging | Every service that logs |

### Prohibited
| Library | Reason | Use instead |
|---------|--------|-------------|
| Moment.js | Deprecated, large | date-fns or Luxon |
| request | Deprecated | Native fetch |

### Getting a new library approved
[Who approves a library that is not listed, and what they need to see.]
```

### 4. Cloud Environment and Services (Both)

```markdown
## Cloud Environment

- **Provider**: [AWS / Azure / GCP]
- **Account structure**: [Single account / Multi-account]
- **Regions**: [Primary, and disaster recovery if any]

### Allowed services
| Service | Approved use | Constraints |
|---------|--------------|-------------|
| AWS Lambda | Event-driven compute, API handlers | 15 min timeout |
| Amazon DynamoDB | Key-value and document storage | On-demand for dev |
| Amazon S3 | Objects, static assets | Versioning and encryption on |

### Disallowed services
| Service | Reason | Use instead |
|---------|--------|-------------|
| Amazon EC2 (direct) | Prefer managed compute | Lambda or ECS Fargate |

### Getting a new service approved
[Who approves a service that is not listed, and what they need to see.]
```

### 5. Architecture and Patterns (Both)

```markdown
## Architecture and Patterns

| Pattern | When to use | When not to use |
|---------|-------------|-----------------|
| Serverless-first | Default for new services | Long-running or connection-heavy work |
| Modular monolith | Single-team projects, first releases | Independently scaled domains |

### API standards
- **Style**: [REST / GraphQL / gRPC]
- **Versioning**: [URL path / header]
- **Documentation**: [OpenAPI 3.x for every REST API]
- **Naming**: [kebab-case URLs, camelCase JSON fields]
- **Errors**: [The standard error response shape]

### Data
- **Primary store**: [e.g. DynamoDB for service-owned data]
- **Relational data**: [e.g. PostgreSQL when queries need joins]
- **Ownership**: [e.g. each service owns its data; no shared databases]

### Messaging
- **Synchronous**: [e.g. HTTP between services]
- **Asynchronous**: [e.g. a queue for tasks, an event bus for events]

### Frontend (if any)
- **Components, state, routing, build tool**: [Your choices]
```

### 6. Security (Both)

```markdown
## Security

### Sign-in and access
- **Authentication**: [e.g. Amazon Cognito, OIDC, SAML]
- **Authorisation model**: [e.g. role-based]
- **Tokens and sessions**: [Format, expiry, refresh]

### Data protection
- **At rest**: [Encryption required, key management]
- **In transit**: [TLS 1.2 or later]
- **Personal data**: [Fields, masking, retention]

### Secrets
- **Storage**: [e.g. AWS Secrets Manager]
- **Rotation**: [Every N days]
- **Never**: secrets in source code, in config files, or shared between services

### Compliance
- **Standards**: [SOC 2, HIPAA, PCI-DSS, GDPR, or "none specific"]
- **Audit logging**: [What is logged, and for how long]
- **Scanning**: [Dependency and image scanning tools]
- **Licences**: [Allowed: MIT, Apache 2.0, BSD. Prohibited: GPL, AGPL]
```

#### セキュリティフレームワークを選ぶ

フレームワークを一つ選び、そのカテゴリーごとに、プロジェクトがどう対処するかを記します。当てはまらないカテゴリーはその理由を記し、後で予定している対策はその不足とフェーズを名指しします。

| Kind of project | Common choices |
|-----------------|----------------|
| Web applications and APIs | OWASP Top 10, OWASP API Security Top 10 |
| Cloud infrastructure | The cloud provider's Well-Architected security pillar, CIS Benchmarks |
| Government or regulated | NIST 800-53, FedRAMP, ISO 27001 |
| General software | CIS Controls v8, SANS Top 25 |

カテゴリーが十以下のフレームワークは、完全な表をこのドキュメントに置いてください。大きなものは、このファイルの隣に専用のファイルで保ち (たとえば
`aidlc-shared/nist-800-53-compliance.md`)、ここからリンクしてください。

### 7. Testing (Both)

```markdown
## Testing

| Test type | Required | Target | Tooling |
|-----------|----------|--------|---------|
| Unit | Yes | 80% line coverage | Jest / pytest |
| Integration | Yes | Every service-to-service call | Testcontainers |
| End-to-end | For key journeys | Critical user journeys | Playwright |
| Performance | When there are targets | The stated response times | k6 |
| Security | Yes | Every public endpoint | OWASP ZAP |

- **Mocking**: [Mock external dependencies, never internal business logic]
- **Test location**: [Next to the source, or a separate tests/ tree]
- **Naming**: [e.g. describe / it]

### Pipeline gates
| Pipeline step | Tests that must pass | On failure |
|---------------|----------------------|------------|
| Pull request | Unit and integration | Block the merge |
| Before staging deploy | End-to-end | Block the deploy |
```

ワークフローがいくつのテストを書くかは、その作業に選ぶテスト戦略にも従います。
[Scopes, Depth, and Test Strategy](../05-scopes-and-depth.md) を参照してください。

### 8. Example Code (Both)

例コードは、よくあることを行う正統なやり方を示すので、生成されるコードは、新しいスタイルを編み出す代わりにそれに従います。

次のうちプロジェクトにあるものについて例を用意してください。プロジェクトのレイアウト、API エンドポイント、データベースアクセス、エラー処理、認可の適用、ユニットテストと統合テスト、ロギング、設定の読み込み、インフラモジュールです。

それらをリポジトリに置いてください。たとえば次のようにします。

```text
project-root/
  examples/
    api-endpoint/
      handler.ts          # working code, not pseudocode
      handler.test.ts     # how to test it
      README.md           # what it shows, when to use it, what to change
    database-access/
      repository.ts
      repository.test.ts
      README.md
```

各例は動作し、テストを伴い、短い README を持つべきです。どのパターンを示すか、いつ使い、いつ使わないか、どの部分を合わせて変え、どの部分をそのまま保つかです。

examples フォルダーはそれ単独では読まれません。このドキュメントで、どの例が何に当てはまるかを記してください。たとえば「すべての API エンドポイントは
`examples/api-endpoint/` に従う」のようにすると、Code Generation がそのステップを計画するときにそれを開きます。標準が変わったら例を最新に保ち、置き換えられたものは `deprecated-` の接頭辞を付けて改名し、置き換え先を指すノートを添えてください。

### 9. Existing Codebase Only

```markdown
## Existing Technical Inventory

- **Languages and frameworks, with versions**: [List]
- **Infrastructure and deployment**: [Services, model]
- **Test coverage today**: [Figure or a short assessment]
- **Known technical debt**: [Key items]

### Keep
| Technology | Reason to keep |
|------------|----------------|

### Migrate
| Today | Target | Priority | Approach |
|-------|--------|----------|----------|
| JavaScript | TypeScript | High | File by file |

### Remove
| Item | Reason | When |
|------|--------|------|

### While old and new coexist
- **API versions**: [How v1 and v2 run side by side]
- **Schema changes**: [How migrations run alongside existing data]
- **Feature flags**: [How new behaviour is switched on]
```

---

## 各セクションの使われ方

| Section | Stage | How it is used |
|---------|-------|----------------|
| Project Technical Summary | Practices Discovery | Team practices and skills |
| Languages, Frameworks and Libraries | NFR Design, Code Generation | What is used, at which version, and what is never added |
| Cloud Services | Feasibility & Constraints, Infrastructure Design | Which services the design may use |
| Architecture and Patterns | Domain Design, Contract Design, Functional Design | Structure, API and data decisions |
| Security | NFR Requirements, NFR Design, Build and Test | Security controls and their checks |
| Testing | Code Generation, Build and Test, CI Pipeline | Test types, coverage and gates |
| Example Code | Code Generation | The pattern each piece of code follows |
| Existing Technical Inventory | Reverse Engineering, Practices Discovery | What to keep, migrate or remove |

どのステージが動くかは、あなたが承認するプランによります。
[Phases and Stages](../04-phases-and-stages.md) を参照してください。
