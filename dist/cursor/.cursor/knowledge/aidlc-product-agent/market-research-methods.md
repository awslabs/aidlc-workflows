# Market Research Methods

## Purpose
Structured approaches for understanding the competitive landscape, sizing the opportunity, and making informed build-vs-buy decisions before committing engineering effort.

## Competitive Analysis Framework

### Step 1: Identify Competitors
- **Direct competitors**: Same product, same market (e.g., Slack vs Teams)
- **Indirect competitors**: Different product, same problem (e.g., Slack vs email)
- **Potential competitors**: Adjacent players who could enter your space

### Step 2: Feature Comparison Matrix

| Capability | Our Product | Competitor A | Competitor B | Competitor C |
|------------|-------------|-------------|-------------|-------------|
| Core Feature 1 | | | | |
| Core Feature 2 | | | | |
| Pricing Model | | | | |
| Target Segment | | | | |
| Integration Ecosystem | | | | |
| Key Differentiator | | | | |

Rate each: Strong / Adequate / Weak / Absent

### Step 3: Positioning Map
Plot competitors on two axes representing the dimensions that matter most to your target users (e.g., Ease of Use vs Power, Price vs Completeness). Identify underserved quadrants.

## SWOT Analysis Template

| | Helpful | Harmful |
|---|---------|---------|
| **Internal** | **Strengths**: What do we do well? What unique resources do we have? | **Weaknesses**: Where do we lack capability? What do competitors do better? |
| **External** | **Opportunities**: What market trends favor us? What unmet needs exist? | **Threats**: What could disrupt us? What are competitors planning? |

### Making SWOT Actionable
- **Strengths + Opportunities** = Strategies to pursue aggressively
- **Weaknesses + Threats** = Risks to mitigate or defend against
- **Strengths + Threats** = Defensive strategies leveraging advantages
- **Weaknesses + Opportunities** = Investments needed to capitalize

## Porter's Five Forces

Assess industry attractiveness by analyzing:

1. **Threat of New Entrants**: How easy is it to enter this market? (Low barriers = high threat)
2. **Bargaining Power of Suppliers**: How dependent are you on key suppliers/platforms? (Single cloud provider = high power)
3. **Bargaining Power of Buyers**: Can customers easily switch? (Low switching costs = high power)
4. **Threat of Substitutes**: Can the problem be solved differently? (Manual process, different tech)
5. **Competitive Rivalry**: How intense is existing competition? (Many similar products = high rivalry)

Rate each force High/Medium/Low. High forces compress margins and reduce attractiveness.

## Market Sizing: TAM / SAM / SOM

### Definitions
- **TAM (Total Addressable Market)**: Total revenue if you captured 100% of the market globally
- **SAM (Serviceable Addressable Market)**: Portion of TAM your product/model can realistically serve (geography, segment, channel)
- **SOM (Serviceable Obtainable Market)**: Realistic market share you can capture in 2-3 years given competition and resources

### Top-Down Calculation
Start with industry reports, narrow by filters:
```
TAM = Total industry revenue for category
SAM = TAM x % in your geography x % in your segment
SOM = SAM x realistic capture rate (typically 1-5% for new entrants)
```

### Bottom-Up Calculation (More Reliable)
```
SOM = Target customers x Average deal size x Purchase frequency
```

Use both methods and compare. If they diverge wildly, investigate assumptions.

## Build vs Buy Assessment

### Evaluation Criteria

| Factor | Build | Buy | Score (Build -2 to +2) |
|--------|-------|-----|----------------------|
| Core differentiator? | Build if it is your competitive advantage | Buy commodity capabilities | |
| Time to market | Months to years | Days to weeks | |
| Total cost (3-year) | Dev + maintenance + opportunity cost | License + integration + vendor risk | |
| Customization needed | High customization favors build | Standard needs favor buy | |
| Data sensitivity | Full control | Vendor data handling policies | |
| Team expertise | Requires in-house skills | Transfers complexity to vendor | |
| Maintenance burden | Ongoing responsibility | Vendor handles updates | |

### Decision Rule
If the capability is not your core differentiator and a mature vendor solution exists, default to Buy. Build only when the capability is central to your competitive advantage or when vendor solutions fundamentally cannot meet your requirements.

## Trend Analysis Methods

### Approaches
- **Technology radar**: Categorize emerging technologies as Adopt / Trial / Assess / Hold
- **Hype cycle mapping**: Identify where relevant technologies sit on the Gartner Hype Cycle
- **Customer signal analysis**: Mine support tickets, feature requests, and churn reasons for emerging patterns
- **Adjacent market monitoring**: Track what is happening in related industries that may spill over

### Validation
Trends are hypotheses. Validate with:
- Customer interviews confirming the trend affects their buying decisions
- Revenue data showing market movement (not just media coverage)
- Competitor investment signals (hiring patterns, acquisitions, product launches)
