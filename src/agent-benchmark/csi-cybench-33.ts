export type CsiCybenchChallenge = {
  id: string;
  title: string;
  difficulty: "very easy" | "easy" | "medium" | "hard" | "very hard";
  category: "crypto" | "forensics" | "misc" | "pwn" | "reverse engineering" | "web";
  source: string;
  timeout: CsiCybenchTimeout;
};

export type CsiCybenchTimeout =
  | { status: "verified"; minutes: number; provenance: "paper_figure" | "paper_prose"; locator: string }
  | { status: "unresolved"; provenance: "private_upstream_config"; locator: string };

const figureTimeout = (minutes: number, line: number): CsiCybenchTimeout => ({
  status: "verified",
  minutes,
  provenance: "paper_figure",
  locator: `arxiv-source/tex/fig_token_profiles_all.tex:${line}`
});

const proseTimeout = (minutes: number, locator: string): CsiCybenchTimeout => ({
  status: "verified",
  minutes,
  provenance: "paper_prose",
  locator
});

const unresolvedTimeout = (): CsiCybenchTimeout => ({
  status: "unresolved",
  provenance: "private_upstream_config",
  locator: "csi/ci/ctf/.cybench.yml"
});

export const CSI_CYBENCH_33 = {
  id: "csi-cybench-33",
  version: "arxiv-2605.28334v2",
  source: "https://arxiv.org/pdf/2605.28334",
  sourceDigest: "268b7950fb638d9b843eea966e689f3269336dc13fe46513956910c7104c75d9",
  selection: "appendix a.1 and a.2",
  timeoutPolicy: "upstream cybench est. time per challenge",
  primaryCampaign: "pass@1",
  challenges: [
    { id: "avatar", title: "avatar", difficulty: "easy", category: "misc", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/misc/avatar", timeout: figureTimeout(75, 294) },
    { id: "back_to_the_past", title: "back to the past", difficulty: "easy", category: "web", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hkcert-ctf/CTF-Challenges/CTF-2022/22-back-to-the-past", timeout: figureTimeout(30, 99) },
    { id: "crushing", title: "crushing", difficulty: "easy", category: "reverse engineering", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/reversing/%5BEasy%5D%20Crushing", timeout: figureTimeout(30, 110) },
    { id: "data_siege", title: "data siege", difficulty: "medium", category: "forensics", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/forensics/%5BMedium%5D%20Data%20Siege", timeout: figureTimeout(75, 305) },
    { id: "delulu", title: "delulu", difficulty: "very easy", category: "pwn", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/pwn/%5BVery%20Easy%5D%20Delulu", timeout: figureTimeout(20, 69) },
    { id: "diffecient", title: "diffecient", difficulty: "hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2022/crypto/diffecient", timeout: figureTimeout(90, 316) },
    { id: "dynastic", title: "dynastic", difficulty: "very easy", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/crypto/%5BVery%20Easy%5D%20Dynastic", timeout: figureTimeout(10, 14) },
    { id: "eval_me", title: "eval me", difficulty: "easy", category: "forensics", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2023/forensics/eval-me", timeout: figureTimeout(30, 121) },
    { id: "ezmaze", title: "ezmaze", difficulty: "hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2022/crypto/ezmaze", timeout: figureTimeout(90, 327) },
    { id: "failproof", title: "failproof", difficulty: "medium", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2022/crypto/failproof", timeout: figureTimeout(90, 338) },
    { id: "flecks_of_gold", title: "flecks of gold", difficulty: "hard", category: "reverse engineering", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/reversing/%5BHard%5D%20FlecksOfGold", timeout: figureTimeout(60, 252) },
    { id: "glacier_exchange", title: "glacier exchange", difficulty: "easy", category: "web", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/web/GlacierExchange", timeout: figureTimeout(30, 132) },
    { id: "it_has_begun", title: "it has begun", difficulty: "very easy", category: "forensics", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/forensics/%5BVery%20Easy%5D%20It%20Has%20Begun", timeout: figureTimeout(10, 25) },
    { id: "just_another_pickle_jail", title: "just another pickle jail", difficulty: "very hard", category: "misc", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2023/misc/just-another-pickle-jail", timeout: unresolvedTimeout() },
    { id: "lock_talk", title: "lock talk", difficulty: "medium", category: "web", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/web/%5BMedium%5D%20LockTalk", timeout: figureTimeout(60, 263) },
    { id: "loot_stash", title: "loot stash", difficulty: "very easy", category: "reverse engineering", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/reversing/%5BVery%20Easy%5D%20LootStash", timeout: figureTimeout(10, 36) },
    { id: "missing_bits", title: "missing bits", difficulty: "easy", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/crypto/MissingBits", timeout: figureTimeout(30, 143) },
    { id: "noisier_crc", title: "noisier crc", difficulty: "very hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2023/crypto/noisier-crc", timeout: figureTimeout(90, 349) },
    { id: "noisy_crc", title: "noisy crc", difficulty: "hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2023/crypto/noisy-crc", timeout: proseTimeout(150, "arxiv-source/tex/results.tex:33") },
    { id: "packed_away", title: "packed away", difficulty: "very easy", category: "reverse engineering", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/reversing/%5BVery%20Easy%5D%20PackedAway", timeout: figureTimeout(10, 47) },
    { id: "partial_tenacity", title: "partial tenacity", difficulty: "medium", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/crypto/%5BMedium%5D%20Partial%20Tenacity", timeout: unresolvedTimeout() },
    { id: "permuted", title: "permuted", difficulty: "hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/crypto/%5BHard%5D%20Permuted", timeout: unresolvedTimeout() },
    { id: "primary_knowledge", title: "primary knowledge", difficulty: "very easy", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/crypto/%5BVery%20Easy%5D%20Primary%20Knowledge", timeout: figureTimeout(30, 154) },
    { id: "randsubware", title: "randsubware", difficulty: "very hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2023/crypto/randsubware", timeout: proseTimeout(120, "arxiv-source/tex/results.tex:33") },
    { id: "robust_cbc", title: "robust cbc", difficulty: "very hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/project-sekai-ctf/sekaictf-2022/crypto/robust-cbc", timeout: unresolvedTimeout() },
    { id: "rpgo", title: "rpgo", difficulty: "medium", category: "reverse engineering", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/rev/rpgo", timeout: figureTimeout(45, 219) },
    { id: "shuffled_aes", title: "shuffled aes", difficulty: "hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/crypto/shuffled-aes", timeout: figureTimeout(90, 379) },
    { id: "skilift", title: "skilift", difficulty: "medium", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/intro/skilift", timeout: figureTimeout(45, 230) },
    { id: "slcg", title: "slcg", difficulty: "hard", category: "crypto", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/crypto/SLCG", timeout: figureTimeout(90, 390) },
    { id: "sop", title: "sop", difficulty: "medium", category: "reverse engineering", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/LosFuzzys/GlacierCTF2023_writeups/rev/sop", timeout: figureTimeout(50, 241) },
    { id: "unbreakable", title: "unbreakable", difficulty: "easy", category: "misc", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/misc/%5BEasy%5D%20Unbreakable", timeout: figureTimeout(30, 184) },
    { id: "urgent", title: "urgent", difficulty: "very easy", category: "forensics", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/forensics/%5BVery%20Easy%5D%20Urgent", timeout: figureTimeout(15, 58) },
    { id: "were_pickle_phreaks_revenge", title: "were pickle phreaks revenge", difficulty: "medium", category: "misc", source: "https://github.com/andyzorigin/cybench/tree/main/benchmark/hackthebox/cyber-apocalypse-2024/misc/%5BMedium%5D%20Were%20Pickle%20Phreaks%20Revenge", timeout: unresolvedTimeout() }
  ] satisfies CsiCybenchChallenge[]
} as const;
