import { defineCollection, z } from 'astro:content';

const notes = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    id: z.string(),
    date: z.string().datetime(),
  }),
});

export const collections = { notes };
