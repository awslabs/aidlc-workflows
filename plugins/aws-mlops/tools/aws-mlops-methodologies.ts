// Read-only availability catalog; scope choice and human approval belong to the engine.
export const methodologies = [
  {
    id: "crisp-mlq",
    name: "CRISP-ML(Q)",
    status: "available",
    scope: "aws-mlops-crisp-mlq",
    purpose: "Full model lifecycle with quality assurance and maintenance",
  },
  {
    id: "crisp-dm",
    name: "CRISP-DM",
    status: "planned",
    scope: null,
    purpose: "Business-led data mining and model development",
  },
  {
    id: "tdsp",
    name: "TDSP",
    status: "planned",
    scope: null,
    purpose: "Team roles, collaboration and iterative delivery",
  },
  {
    id: "semma",
    name: "SEMMA",
    status: "planned",
    scope: null,
    purpose: "Data sampling, exploration, modification, modeling and assessment",
  },
  {
    id: "kdd",
    name: "KDD",
    status: "planned",
    scope: null,
    purpose: "Knowledge discovery from data",
  },
] as const;

if (import.meta.main) {
  console.log(JSON.stringify({ methodologies }, null, 2));
}
