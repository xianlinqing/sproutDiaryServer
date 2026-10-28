import { z } from "zod";
import { randomUUID } from "node:crypto";

export const day = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  );
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T12:00:00Z");
    return !isNaN(+d) && d.toISOString().slice(0, 10) === v;
  }, "日期无效");
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const photo = z
  .string()
  .regex(/^(plant:(tomato|jasmine|mint|monstera)|media:[a-f0-9-]{36})$/);
export const plantSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(30),
    species: z.string().max(40),
    location: z.string().max(40),
    date,
    cover: photo,
  })
  .strict();
export const entrySchema = z
  .object({
    id,
    plantId: id,
    date,
    title: z.string().max(60),
    text: z.string().max(1000),
    photos: z.array(photo).max(6),
    stage: z.string().min(1).max(30),
    kind: z.enum(["diary", "care"]),
  })
  .strict();
export const taskSchema = z
  .object({
    id,
    plantId: id,
    type: z.string().trim().min(1).max(30),
    due: date,
    repeat: z.number().int().min(0).max(365),
    status: z.enum(["pending", "done", "skipped"]),
    completed: date.optional(),
  })
  .strict();
export const gardenSchema = z
  .object({
    version: z.literal(1),
    plants: z.array(plantSchema).max(500),
    entries: z.array(entrySchema).max(5000),
    tasks: z.array(taskSchema).max(3000),
  })
  .strict()
  .superRefine((s, c) => {
    for (const [key, items] of Object.entries({
      plants: s.plants,
      entries: s.entries,
      tasks: s.tasks,
    })) {
      if (new Set(items.map((x) => x.id)).size !== items.length)
        c.addIssue({ code: "custom", message: key + " ID重复" });
    }
    const plants = new Map(s.plants.map((p) => [p.id, p]));
    for (const p of s.plants)
      if (p.date > day())
        c.addIssue({ code: "custom", message: "种植日期不能晚于今天" });
    for (const e of s.entries)
      if (
        !plants.has(e.plantId) ||
        e.date < plants.get(e.plantId)!.date ||
        e.date > day()
      )
        c.addIssue({ code: "custom", message: "日记植物关联或日期无效" });
    for (const t of s.tasks)
      if (
        !plants.has(t.plantId) ||
        (t.status === "done" && !t.completed) ||
        (t.completed && t.completed > day())
      )
        c.addIssue({ code: "custom", message: "养护关联或完成日期无效" });
  });
export type Garden = z.infer<typeof gardenSchema>;
export const emptyGarden = (): Garden => ({
  version: 1,
  plants: [],
  entries: [],
  tasks: [],
});
export const revisionSchema = z.number().int().min(0).max(2147483646);
export function taskAction(s: Garden, id: string, action: string) {
  const t = s.tasks.find((t) => t.id === id);
  if (!t || t.status !== "pending") throw new Error("任务不存在或已经处理");
  const add = (d: string, n: number) =>
    new Date(Date.parse(d + "T12:00:00Z") + n * 86400000)
      .toISOString()
      .slice(0, 10);
  if (action === "postpone") {
    t.due = add(t.due < day() ? day() : t.due, 1);
    return;
  }
  if (action === "complete") {
    t.status = "done";
    t.completed = day();
    s.entries.push({
      id: randomUUID(),
      plantId: t.plantId,
      date: day(),
      title: t.type,
      text: "完成了" + t.type,
      photos: [],
      stage: t.type,
      kind: "care",
    });
  } else t.status = "skipped";
  if (t.repeat)
    s.tasks.push({
      ...t,
      id: randomUUID(),
      due: add(day(), t.repeat),
      status: "pending",
      completed: undefined,
    });
}
