// The choices offered in Setup dropdowns. Pure data, no secrets.

/** Funding stages, newest to oldest. Each is matched against the round type from the company lookup. */
export const STAGE_OPTIONS: { name: string; re: RegExp }[] = [
  { name: "Pre-Seed", re: /pre-?seed|angel|accelerator|incubator/ },
  { name: "Seed", re: /\bseed\b/ },
  { name: "Series A", re: /series a\b/ },
  { name: "Series B", re: /series b\b/ },
  { name: "Series C", re: /series c\b/ },
  { name: "Series D", re: /series d\b/ },
  { name: "Series E or later", re: /series [e-z]\b/ },
  { name: "Growth / late stage", re: /growth|late stage|venture|private equity|corporate round|secondary/ },
  { name: "Public (IPO)", re: /ipo|public/ },
  { name: "Acquired", re: /acqui|buyout|merger/ },
];
export const STAGES = STAGE_OPTIONS.map((s) => s.name);

const G = (s: string) => s.split(" ");
/** Location groups that stand for several countries (ISO codes). */
export const REGION_GROUPS: Record<string, string[]> = {
  US: ["US"], UK: ["GB"], Canada: ["CA"], India: ["IN"], "Australia / NZ": ["AU", "NZ"],
  "North America": G("US CA MX"),
  EU: G("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE NO CH"),
  "Europe (all)": G("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE NO CH GB IS UA RS AL BA MK ME MD BY"),
  "DACH (Germany, Austria, Switzerland)": G("DE AT CH"),
  Nordics: G("SE NO DK FI IS"),
  "Asia-Pacific": G("IN CN JP KR SG AU NZ HK TW ID MY TH VN PH BD LK PK"),
  "Southeast Asia": G("SG ID MY TH VN PH"),
  "Middle East": G("AE SA IL QA KW BH OM JO LB TR"),
  "Latin America": G("MX BR AR CL CO PE UY CR PA EC"),
  Africa: G("ZA NG KE EG GH MA TN RW"),
};

const C = "US:United States|GB:United Kingdom|CA:Canada|IN:India|AU:Australia|NZ:New Zealand|DE:Germany|FR:France|NL:Netherlands|ES:Spain|IT:Italy|PT:Portugal|IE:Ireland|BE:Belgium|LU:Luxembourg|AT:Austria|CH:Switzerland|SE:Sweden|NO:Norway|DK:Denmark|FI:Finland|IS:Iceland|PL:Poland|CZ:Czechia|SK:Slovakia|HU:Hungary|RO:Romania|BG:Bulgaria|GR:Greece|HR:Croatia|SI:Slovenia|EE:Estonia|LV:Latvia|LT:Lithuania|CY:Cyprus|MT:Malta|UA:Ukraine|RS:Serbia|TR:Turkey|IL:Israel|AE:United Arab Emirates|SA:Saudi Arabia|QA:Qatar|KW:Kuwait|BH:Bahrain|OM:Oman|JO:Jordan|LB:Lebanon|EG:Egypt|ZA:South Africa|NG:Nigeria|KE:Kenya|GH:Ghana|MA:Morocco|TN:Tunisia|RW:Rwanda|SG:Singapore|HK:Hong Kong|CN:China|JP:Japan|KR:South Korea|TW:Taiwan|ID:Indonesia|MY:Malaysia|TH:Thailand|VN:Vietnam|PH:Philippines|BD:Bangladesh|LK:Sri Lanka|PK:Pakistan|MX:Mexico|BR:Brazil|AR:Argentina|CL:Chile|CO:Colombia|PE:Peru|UY:Uruguay|CR:Costa Rica|PA:Panama|EC:Ecuador";
export const COUNTRIES: [string, string][] = C.split("|").map((x) => x.split(":") as [string, string]);

/** Every location choice: the groups first, then countries. */
export const REGIONS = [...Object.keys(REGION_GROUPS), ...COUNTRIES.map(([, n]) => n).filter((n) => !(n in REGION_GROUPS))]; // India and Canada are both a group and a country: listed once

/** The ISO codes a chosen location stands for. */
export function codesFor(region: string): string[] {
  if (REGION_GROUPS[region]) return REGION_GROUPS[region];
  const c = COUNTRIES.find(([, n]) => n === region);
  return c ? [c[0]] : [];
}

/** Industries, newest kinds first, then established ones. Matched loosely against the company's industry and tags. */
export const INDUSTRIES: string[] = [
  // Software and technology
  "B2B SaaS", "Vertical SaaS", "Developer tools", "Infrastructure software", "Cloud computing", "Cybersecurity", "Data and analytics", "AI and machine learning",
  "Generative AI", "Data infrastructure", "DevOps and observability", "API platforms", "Low-code / no-code", "Open source", "Web3 and blockchain", "Quantum computing",
  "Robotics and automation", "IoT and hardware", "Semiconductors", "Telecommunications", "AR / VR and spatial computing", "Gaming and esports", "Consumer apps", "Marketplaces",
  // Business software
  "Sales and marketing tech", "RevOps and sales enablement", "Customer support software", "HR tech and recruiting", "Legal tech", "Proptech and real estate", "Govtech",
  "Martech and adtech", "Collaboration and productivity", "ERP and back office", "Procurement and spend management", "Compliance and risk (GRC)", "Identity and access",
  // Money
  "Fintech", "Payments", "Banking and neobanks", "Lending and credit", "Insurance and insurtech", "Wealth and asset management", "Accounting and bookkeeping software", "Crypto and digital assets", "Capital markets", "Embedded finance",
  // Consumer and commerce
  "D2C and consumer brands", "E-commerce", "Retail", "Food and beverage", "Restaurants and hospitality", "Travel and tourism", "Fashion and apparel", "Beauty and personal care", "Consumer packaged goods", "Sports and fitness", "Pets", "Media and entertainment", "Music and audio", "Publishing and news", "Creator economy", "Social networks",
  // Health and science
  "Healthtech", "Digital health", "Biotech", "Pharmaceuticals", "Medical devices", "Mental health and wellness", "Life sciences", "Agritech", "Foodtech", "Veterinary",
  // Industry and infrastructure
  "Climate tech and cleantech", "Energy and utilities", "Renewable energy", "Oil and gas", "Mining and metals", "Manufacturing", "Industrial technology", "Construction and engineering", "Automotive", "Electric vehicles and mobility", "Aerospace and defense", "Space tech", "Logistics and supply chain", "Transportation and shipping", "Chemicals", "Packaging", "Waste and recycling",
  // Services and public
  "Edtech and education", "Consulting and professional services", "Staffing and recruiting agencies", "Marketing and advertising agencies", "IT services and outsourcing", "Legal services", "Accounting services", "Real estate and property", "Financial services (traditional)", "Government and public sector", "Nonprofit", "Security services", "Events and exhibitions", "Telecom services", "Wholesale and distribution", "Agriculture", "Printing and publishing (legacy)", "Hardware and electronics (legacy)",
];
