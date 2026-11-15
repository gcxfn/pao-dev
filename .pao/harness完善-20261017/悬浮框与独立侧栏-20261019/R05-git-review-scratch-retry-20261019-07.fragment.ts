import { rm } from "node:fs/promises";

async function cleanScratch(scratch: string) {
  try {
    return "patch";
  } finally {
    await rm(scratch, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}

void cleanScratch;
