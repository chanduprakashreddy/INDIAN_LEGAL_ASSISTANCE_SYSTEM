// Client-safe shared types for the legal assistant.

export type Citation = {
  index: number;
  actName: string;
  section: string | null;
  year: number | null;
  sourceUrl: string | null;
  excerpt: string;
  origin: "corpus" | "indiacode" | "webscrape";
  score: number | null;
};

export type Grounding = "corpus" | "indiacode" | "webscrape" | "none";

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  grounding: Grounding;
  createdAt: string;
};

export type ThreadSummary = {
  id: string;
  title: string;
  language: string;
  matterId: string | null;
  updatedAt: string;
};

export const DOCUMENT_TYPES = [
  {
    id: "affidavit",
    name: "Affidavit",
    blurb: "General sworn statement for courts and authorities",
    fields: [
      { name: "deponentName", label: "Your full name", required: true },
      { name: "deponentAddress", label: "Your address", required: true },
      { name: "age", label: "Age", required: false },
      { name: "court", label: "Court / authority it is for", required: false },
      { name: "purpose", label: "What are you affirming?", required: true, long: true },
    ],
  },
  {
    id: "legal-notice",
    name: "Legal notice",
    blurb: "Formal notice before initiating proceedings",
    fields: [
      { name: "senderName", label: "Your name", required: true },
      { name: "senderAddress", label: "Your address", required: true },
      { name: "recipientName", label: "Recipient name", required: true },
      { name: "recipientAddress", label: "Recipient address", required: true },
      { name: "facts", label: "What happened?", required: true, long: true },
      { name: "demand", label: "What do you want them to do?", required: true, long: true },
    ],
  },
  {
    id: "rti",
    name: "RTI application",
    blurb: "Right to Information request under the RTI Act, 2005",
    fields: [
      { name: "applicantName", label: "Your name", required: true },
      { name: "applicantAddress", label: "Your address", required: true },
      { name: "publicAuthority", label: "Public authority / department", required: true },
      { name: "information", label: "Information you are seeking", required: true, long: true },
    ],
  },
  {
    id: "bail-application",
    name: "Bail application",
    blurb: "Application for regular or anticipatory bail",
    fields: [
      { name: "applicantName", label: "Applicant name", required: true },
      { name: "court", label: "Court", required: true },
      { name: "caseNumber", label: "FIR / case number", required: false },
      { name: "policeStation", label: "Police station", required: false },
      { name: "sections", label: "Sections alleged", required: false },
      { name: "grounds", label: "Grounds for bail", required: true, long: true },
    ],
  },
  {
    id: "rent-agreement",
    name: "Rent agreement",
    blurb: "Residential lease between landlord and tenant",
    fields: [
      { name: "landlord", label: "Landlord name", required: true },
      { name: "tenant", label: "Tenant name", required: true },
      { name: "propertyAddress", label: "Property address", required: true },
      { name: "rent", label: "Monthly rent", required: true },
      { name: "deposit", label: "Security deposit", required: false },
      { name: "term", label: "Duration (e.g. 11 months)", required: true },
      { name: "specialTerms", label: "Any special conditions", required: false, long: true },
    ],
  },
  {
    id: "complaint-letter",
    name: "Complaint letter",
    blurb: "Consumer or police complaint",
    fields: [
      { name: "complainantName", label: "Your name", required: true },
      { name: "complainantAddress", label: "Your address", required: true },
      { name: "against", label: "Complaint against", required: true },
      { name: "authority", label: "Authority it is addressed to", required: true },
      { name: "facts", label: "What happened?", required: true, long: true },
      { name: "relief", label: "Relief sought", required: false, long: true },
    ],
  },
  {
    id: "power-of-attorney",
    name: "Power of attorney",
    blurb: "Authorise another person to act for you",
    fields: [
      { name: "principal", label: "Your name (principal)", required: true },
      { name: "attorney", label: "Name of attorney holder", required: true },
      { name: "powers", label: "Powers being granted", required: true, long: true },
      { name: "duration", label: "Validity period", required: false },
    ],
  },
] as const;

export type DocumentTypeId = (typeof DOCUMENT_TYPES)[number]["id"];

export function documentTypeName(id: string): string {
  return DOCUMENT_TYPES.find((type) => type.id === id)?.name ?? id;
}
