// Client-safe language configuration and UI strings.

export const LANGUAGES = [
  { code: "en", label: "English", native: "English" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
  { code: "te", label: "Telugu", native: "తెలుగు" },
  { code: "ta", label: "Tamil", native: "தமிழ்" },
  { code: "kn", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "bn", label: "Bengali", native: "বাংলা" },
  { code: "mr", label: "Marathi", native: "मराठी" },
  { code: "ml", label: "Malayalam", native: "മലയാളം" },
  { code: "gu", label: "Gujarati", native: "ગુજરાતી" },
  { code: "ur", label: "Urdu", native: "اردو" },
  { code: "pa", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "or", label: "Odia", native: "ଓଡ଼ିଆ" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? "English";
}

export function isLanguageCode(value: string): value is LanguageCode {
  return LANGUAGES.some((language) => language.code === value);
}

type Dictionary = Record<string, string>;

const en: Dictionary = {
  "app.name": "NyayaSahay",
  "app.tagline": "Personal legal assistance for the Indian judicial system",
  "nav.home": "Home",
  "nav.chat": "Consult",
  "nav.documents": "Documents",
  "nav.matters": "My cases",
  "nav.library": "Law library",
  "cta.start": "Start a consultation",
  "cta.documents": "Work with documents",
  "chat.placeholder": "Ask about any Indian law, section, or your own situation…",
  "chat.send": "Send",
  "chat.new": "New consultation",
  "chat.empty.title": "How can I help with your legal question?",
  "chat.empty.body":
    "Ask about a section, a procedure, your rights, or describe your situation. Answers cite the Acts they come from.",
  "chat.sources": "Sources",
  "chat.thinking": "Researching the law…",
  "chat.language": "Answer language",
  "disclaimer.short":
    "Informational guidance based on Indian law. Not a substitute for advice from a licensed advocate.",
  "documents.generate": "Generate a document",
  "documents.explain": "Explain a document",
  "documents.enhance": "Improve a scan",
  "matters.new": "New case file",
  "library.title": "Law library",
  "common.loading": "Loading…",
  "common.download": "Download",
  "common.copy": "Copy",
  "common.delete": "Delete",
  "common.save": "Save",
  "common.cancel": "Cancel",
};

// Interface strings for supported Indian languages. Answers, documents and
// explanations are produced directly in the selected language by the model.
const translations: Record<string, Dictionary> = {
  en,
  hi: {
    "app.tagline": "भारतीय न्याय व्यवस्था के लिए व्यक्तिगत कानूनी सहायता",
    "nav.home": "होम",
    "nav.chat": "परामर्श",
    "nav.documents": "दस्तावेज़",
    "nav.matters": "मेरे मामले",
    "nav.library": "विधि पुस्तकालय",
    "cta.start": "परामर्श शुरू करें",
    "cta.documents": "दस्तावेज़ों पर काम करें",
    "chat.placeholder": "किसी भी भारतीय कानून, धारा या अपनी स्थिति के बारे में पूछें…",
    "chat.send": "भेजें",
    "chat.new": "नया परामर्श",
    "chat.empty.title": "आपके कानूनी प्रश्न में मैं कैसे मदद कर सकता हूँ?",
    "chat.sources": "स्रोत",
    "chat.thinking": "कानून की जाँच हो रही है…",
    "chat.language": "उत्तर की भाषा",
    "disclaimer.short":
      "यह भारतीय कानून पर आधारित सामान्य जानकारी है, अधिवक्ता की सलाह का विकल्प नहीं।",
    "documents.generate": "दस्तावेज़ बनाएँ",
    "documents.explain": "दस्तावेज़ समझाएँ",
    "documents.enhance": "स्कैन सुधारें",
    "matters.new": "नई केस फ़ाइल",
    "library.title": "विधि पुस्तकालय",
  },
  te: {
    "app.tagline": "భారత న్యాయ వ్యవస్థ కోసం వ్యక్తిగత న్యాయ సహాయం",
    "nav.home": "హోమ్",
    "nav.chat": "సంప్రదింపు",
    "nav.documents": "పత్రాలు",
    "nav.matters": "నా కేసులు",
    "nav.library": "చట్ట గ్రంథాలయం",
    "cta.start": "సంప్రదింపు ప్రారంభించండి",
    "cta.documents": "పత్రాలతో పని చేయండి",
    "chat.placeholder": "ఏ భారతీయ చట్టం, సెక్షన్ లేదా మీ పరిస్థితి గురించి అడగండి…",
    "chat.send": "పంపండి",
    "chat.new": "కొత్త సంప్రదింపు",
    "chat.empty.title": "మీ న్యాయ ప్రశ్నలో నేను ఎలా సహాయపడగలను?",
    "chat.sources": "మూలాలు",
    "chat.thinking": "చట్టాన్ని పరిశీలిస్తున్నాను…",
    "chat.language": "సమాధాన భాష",
    "disclaimer.short":
      "ఇది భారత చట్టాల ఆధారిత సమాచారం మాత్రమే, న్యాయవాది సలహాకు ప్రత్యామ్నాయం కాదు.",
    "documents.generate": "పత్రం సృష్టించండి",
    "documents.explain": "పత్రాన్ని వివరించండి",
    "documents.enhance": "స్కాన్ మెరుగుపరచండి",
    "matters.new": "కొత్త కేసు ఫైల్",
    "library.title": "చట్ట గ్రంథాలయం",
  },
  ta: {
    "app.tagline": "இந்திய நீதி அமைப்புக்கான தனிப்பட்ட சட்ட உதவி",
    "nav.home": "முகப்பு",
    "nav.chat": "ஆலோசனை",
    "nav.documents": "ஆவணங்கள்",
    "nav.matters": "என் வழக்குகள்",
    "nav.library": "சட்ட நூலகம்",
    "cta.start": "ஆலோசனையைத் தொடங்கு",
    "cta.documents": "ஆவணங்களில் வேலை செய்",
    "chat.placeholder": "எந்த இந்திய சட்டம், பிரிவு அல்லது உங்கள் நிலை பற்றி கேளுங்கள்…",
    "chat.send": "அனுப்பு",
    "chat.new": "புதிய ஆலோசனை",
    "chat.empty.title": "உங்கள் சட்டக் கேள்விக்கு எப்படி உதவ முடியும்?",
    "chat.sources": "ஆதாரங்கள்",
    "chat.thinking": "சட்டத்தை ஆராய்கிறேன்…",
    "chat.language": "பதில் மொழி",
    "disclaimer.short":
      "இது இந்திய சட்டங்களை அடிப்படையாகக் கொண்ட தகவல் மட்டுமே; வழக்கறிஞர் ஆலோசனைக்கு மாற்று அல்ல.",
    "documents.generate": "ஆவணத்தை உருவாக்கு",
    "documents.explain": "ஆவணத்தை விளக்கு",
    "documents.enhance": "ஸ்கேனை மேம்படுத்து",
    "matters.new": "புதிய வழக்குக் கோப்பு",
    "library.title": "சட்ட நூலகம்",
  },
  kn: {
    "app.tagline": "ಭಾರತೀಯ ನ್ಯಾಯ ವ್ಯವಸ್ಥೆಗಾಗಿ ವೈಯಕ್ತಿಕ ಕಾನೂನು ಸಹಾಯ",
    "nav.home": "ಮುಖಪುಟ",
    "nav.chat": "ಸಲಹೆ",
    "nav.documents": "ದಾಖಲೆಗಳು",
    "nav.matters": "ನನ್ನ ಪ್ರಕರಣಗಳು",
    "nav.library": "ಕಾನೂನು ಗ್ರಂಥಾಲಯ",
    "cta.start": "ಸಲಹೆ ಪ್ರಾರಂಭಿಸಿ",
    "cta.documents": "ದಾಖಲೆಗಳೊಂದಿಗೆ ಕೆಲಸ ಮಾಡಿ",
    "chat.placeholder": "ಯಾವುದೇ ಭಾರತೀಯ ಕಾನೂನು, ವಿಭಾಗ ಅಥವಾ ನಿಮ್ಮ ಸ್ಥಿತಿಯ ಬಗ್ಗೆ ಕೇಳಿ…",
    "chat.send": "ಕಳುಹಿಸಿ",
    "chat.new": "ಹೊಸ ಸಲಹೆ",
    "chat.empty.title": "ನಿಮ್ಮ ಕಾನೂನು ಪ್ರಶ್ನೆಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
    "chat.sources": "ಮೂಲಗಳು",
    "chat.thinking": "ಕಾನೂನನ್ನು ಪರಿಶೀಲಿಸುತ್ತಿದ್ದೇನೆ…",
    "chat.language": "ಉತ್ತರದ ಭಾಷೆ",
    "disclaimer.short":
      "ಇದು ಭಾರತೀಯ ಕಾನೂನು ಆಧಾರಿತ ಮಾಹಿತಿ ಮಾತ್ರ; ವಕೀಲರ ಸಲಹೆಗೆ ಪರ್ಯಾಯವಲ್ಲ.",
    "documents.generate": "ದಾಖಲೆ ರಚಿಸಿ",
    "documents.explain": "ದಾಖಲೆ ವಿವರಿಸಿ",
    "documents.enhance": "ಸ್ಕ್ಯಾನ್ ಸುಧಾರಿಸಿ",
    "matters.new": "ಹೊಸ ಪ್ರಕರಣ ಕಡತ",
    "library.title": "ಕಾನೂನು ಗ್ರಂಥಾಲಯ",
  },
  bn: {
    "app.tagline": "ভারতীয় বিচারব্যবস্থার জন্য ব্যক্তিগত আইনি সহায়তা",
    "nav.home": "হোম",
    "nav.chat": "পরামর্শ",
    "nav.documents": "নথি",
    "nav.matters": "আমার মামলা",
    "nav.library": "আইন গ্রন্থাগার",
    "cta.start": "পরামর্শ শুরু করুন",
    "cta.documents": "নথি নিয়ে কাজ করুন",
    "chat.placeholder": "যেকোনো ভারতীয় আইন, ধারা বা আপনার পরিস্থিতি সম্পর্কে জিজ্ঞাসা করুন…",
    "chat.send": "পাঠান",
    "chat.new": "নতুন পরামর্শ",
    "chat.empty.title": "আপনার আইনি প্রশ্নে কীভাবে সহায়তা করতে পারি?",
    "chat.sources": "সূত্র",
    "chat.thinking": "আইন পরীক্ষা করা হচ্ছে…",
    "chat.language": "উত্তরের ভাষা",
    "disclaimer.short":
      "এটি ভারতীয় আইনভিত্তিক তথ্য মাত্র, আইনজীবীর পরামর্শের বিকল্প নয়।",
    "documents.generate": "নথি তৈরি করুন",
    "documents.explain": "নথি ব্যাখ্যা করুন",
    "documents.enhance": "স্ক্যান উন্নত করুন",
    "matters.new": "নতুন মামলার ফাইল",
    "library.title": "আইন গ্রন্থাগার",
  },
};

export function translate(language: string, key: string): string {
  return translations[language]?.[key] ?? en[key] ?? key;
}
