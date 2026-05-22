/**
 * Neuralgentics — Markdown Skill Loader
 *
 * Loads skills from `./skills/*.md` files. Parses YAML frontmatter
 * delimited by `---` at the top of each file.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Skill } from './types.js';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

/**
 * Parse YAML frontmatter from a markdown string.
 * Simple key: value parser — no third-party YAML dependency needed.
 */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: {}, content: raw.trim() };
  }

  const yamlStr = match[1];
  const body = match[2].trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    // Parse simple scalar types
    if (value === 'true') {
      frontmatter[key] = true;
    } else if (value === 'false') {
      frontmatter[key] = false;
    } else if (value === 'null' || value === '') {
      frontmatter[key] = null;
    } else if (/^\d+$/.test(value)) {
      frontmatter[key] = Number(value);
    } else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: body };
}

/**
 * Load a single skill from a markdown file path.
 */
async function loadSkillFile(filePath: string): Promise<Skill | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(raw);

    const name = (frontmatter.name as string) ?? filePath.replace(/\.md$/, '');
    if (!name) return null;

    return {
      name,
      description: (frontmatter.description as string) ?? '',
      model: frontmatter.model === 'secondary' ? 'secondary' : 'primary',
      content,
      frontmatter,
    };
  } catch (err) {
    console.warn(`[Skills] Failed to load skill from ${filePath}:`, err);
    return null;
  }
}

/**
 * Load all skills from a directory of markdown files.
 * Returns a Map of skill name → Skill for O(1) lookup.
 */
export async function loadSkills(skillsDir: string): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    console.warn(`[Skills] Skills directory not found: ${skillsDir}`);
    return skills;
  }

  const mdFiles = entries.filter((f) => f.endsWith('.md'));

  await Promise.all(
    mdFiles.map(async (filename) => {
      const skill = await loadSkillFile(join(skillsDir, filename));
      if (skill) {
        skills.set(skill.name, skill);
      }
    })
  );

  return skills;
}

/**
 * Get a single skill by name from the skills directory.
 */
export async function getSkill(
  skillsDir: string,
  name: string
): Promise<Skill | null> {
  const skills = await loadSkills(skillsDir);
  return skills.get(name) ?? null;
}