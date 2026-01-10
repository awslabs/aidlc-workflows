# AI-DLC Multi-User Quick Reference

## 🚀 Quick Start

### Lead Developer
```bash
kiro-cli chat "Create [your project description]"
# Complete inception → Choose Option B
```

### Team Members
```bash
git pull origin main
kiro-cli chat "claim unit <unit-name>"
# Work on unit → Complete
kiro-cli chat "complete unit <unit-name>"
```

### Integrator
```bash
kiro-cli chat "consolidate units"
```

## 📋 Commands

| Command | What It Does |
|---------|--------------|
| `list units` | Show all units and status |
| `claim unit <name>` | Start working on a unit |
| `complete unit <name>` | Finish your unit |
| `merge unit <name>` | Merge unit to main |
| `consolidate units` | Merge all units |
| `unit status <name>` | Check unit details |
| `show audit` | Your activity log |
| `show all audits` | Team activity logs |

## 🌳 Branch Structure

```
main                           # Shared inception artifacts
├── unit/user-service-alice    # Alice's work
├── unit/auth-service-bob      # Bob's work
└── unit/api-gateway-charlie   # Charlie's work
```

## 📁 File Structure

```
aidlc-docs/
├── audit/
│   ├── user-alice-audit.md    # Alice's log
│   ├── user-bob-audit.md      # Bob's log
│   └── audit-index.md         # All logs
├── construction/
│   ├── unit-assignments.md    # Who's doing what
│   └── consolidated-index.md  # Merged units
```

## 🔄 Workflow

```
Inception (Lead) → Units Generated
                        ↓
        ┌───────────────┼───────────────┐
        ↓               ↓               ↓
    Alice (Unit 1)  Bob (Unit 2)  Charlie (Unit 3)
        ↓               ↓               ↓
    Complete        Complete        Complete
        └───────────────┼───────────────┘
                        ↓
                  Consolidate
                        ↓
                  Build & Test
```

## ✅ Status Icons

- ✅ Completed
- 🔄 In Progress
- ⭐ Available
- ⏳ Blocked (waiting on dependency)

## 🎯 Best Practices

1. **Check dependencies** before claiming units
2. **Commit often** in your unit branch
3. **Complete units** when all stages done
4. **Consolidate regularly** to avoid drift
5. **Review audits** for team coordination

## 🆘 Quick Fixes

**Branch exists?**
```bash
git branch -D unit/name-user
kiro-cli chat "claim unit name"
```

**Out of sync?**
```bash
git pull origin main
kiro-cli chat "list units"
```

**Check status?**
```bash
kiro-cli chat "unit status <name>"
```

## 📞 Need Help?

```bash
kiro-cli chat "show all audits"      # See what everyone did
kiro-cli chat "list units"           # See current status
cat aidlc-docs/construction/unit-assignments.md
```

## 🎓 Example Session

```bash
# Alice starts project
kiro-cli chat "Create e-commerce API"
# → Completes inception, enables team

# Bob joins
git pull origin main
kiro-cli chat "claim unit product-catalog"
# → Works on unit
kiro-cli chat "complete unit product-catalog"

# Charlie joins
git pull origin main
kiro-cli chat "claim unit shopping-cart"
# → Works on unit
kiro-cli chat "complete unit shopping-cart"

# Alice consolidates
kiro-cli chat "consolidate units"
# → All units merged, build & test starts
```

## 💡 Pro Tips

- Use `kiro-cli chat "I want to work on X"` instead of `claim unit X`
- Use `kiro-cli chat "I'm done with X"` instead of `complete unit X`
- Use `kiro-cli chat "what's available?"` instead of `list units`
- AI understands natural language!

---

**Full Guide**: See `MULTI-USER-GUIDE.md`
**Implementation Details**: See `MULTI-USER-IMPLEMENTATION.md`
