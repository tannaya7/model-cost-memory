import { describe, expect, it } from "vitest";
import { inviteToken } from "./inviteToken";

const CODE = "Abc123_-Abc123_-Abc123_-Abc123_-Abc123_-xyz";

describe("reading an invite the way people paste it", () => {
  it("takes the code from a full link, a path, or the bare code", () => {
    expect(inviteToken(`https://app.example.com/join/${CODE}`)).toBe(CODE);
    expect(inviteToken(`/join/${CODE}`)).toBe(CODE);
    expect(inviteToken(`  ${CODE}\n`)).toBe(CODE);
    expect(inviteToken(`https://app.example.com/join/${CODE}?utm=x`)).toBe(CODE);
  });

  it("refuses anything that is not an invite, without calling it a code", () => {
    for (const bad of ["", "   ", "hello", "acme", "a b c d e f g h i j k l m n o p", "https://example.com/other/path", `${CODE}!!`]) {
      expect(inviteToken(bad), bad).toBeNull();
    }
  });
});
