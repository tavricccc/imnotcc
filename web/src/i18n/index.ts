// The few strings the Novae primitives ask for. imnotcc is Traditional Chinese only.
const STRINGS: Record<string, string> = {
  "common.close": "關閉",
  "ui.common.cancel": "取消",
  "ui.common.save": "儲存",
  "admin.resetField": "重設{field}",
};

export function t(key: string, vars: Record<string, string> = {}) {
  return (STRINGS[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
}

export function useI18n() {
  return { t };
}
