# User Flow — API Consumer Interaction

## Primary Flow: Successful Calculation

```
Client                          API
  │                              │
  ├─ POST /api/v1/arithmetic/add │
  │  {"a": 5, "b": 3}           │
  │                              │
  │  ◄─── 200 ──────────────────┤
  │  {"status":"ok",             │
  │   "operation":"add",         │
  │   "inputs":{"a":5,"b":3},   │
  │   "result":8}               │
```

## Error Flow: Domain Violation

```
Client                          API
  │                              │
  ├─ POST /api/v1/powers/sqrt    │
  │  {"a": -1}                   │
  │                              │
  │  ◄─── 400 ──────────────────┤
  │  {"status":"error",          │
  │   "operation":"sqrt",        │
  │   "inputs":{"a":-1},        │
  │   "error":{"code":           │
  │     "DOMAIN_ERROR",          │
  │     "message":"..."}}        │
```

## Discovery Flow: Constants

```
Client                          API
  │                              │
  ├─ GET /api/v1/constants       │
  │                              │
  │  ◄─── 200 ──────────────────┤
  │  {"status":"ok",             │
  │   "operation":"constants",   │
  │   "inputs":{},              │
  │   "result":{"pi":3.14159.., │
  │     "e":2.71828.., ...}}    │
```

## Conversion Flow

```
Client                          API
  │                              │
  ├─ POST /api/v1/conversions/   │
  │       temperature            │
  │  {"value":100,               │
  │   "from_unit":"celsius",     │
  │   "to_unit":"fahrenheit"}    │
  │                              │
  │  ◄─── 200 ──────────────────┤
  │  {"status":"ok",             │
  │   "operation":"temperature", │
  │   "inputs":{...},           │
  │   "result":212.0}           │
```

## Health Check Flow

```
Client                          API
  │                              │
  ├─ GET /health                 │
  │                              │
  │  ◄─── 200 ──────────────────┤
  │  {"status":"ok",             │
  │   "version":"0.1.0"}        │
```
