with open("app/manual-attendance/[classId]/actions.ts", "r") as f:
    content = f.read()

content = content.replace("source: 'manual_class_teacher',", "source: 'manual' as const,")
content = content.replace("direction: 'in',", "direction: 'in' as const,")

with open("app/manual-attendance/[classId]/actions.ts", "w") as f:
    f.write(content)
