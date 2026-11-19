/** People name an AI task in their own words ("Read invoices"). The recorder in their app needs a short code-safe name
 *  for it ("read-invoices"). This makes the second from the first, so nobody has to know the rules. */
export function codeName(plain: string): string {
  const base = plain
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // é -> e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.slice(0, 40).replace(/-+$/g, "");
}

/** What a person is told about the code name, in one sentence. */
export const CODE_NAME_NOTE = "Your app uses this short name to say which task a call belongs to. It is made from the words you typed.";
