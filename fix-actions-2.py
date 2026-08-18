with open("app/manual-attendance/[classId]/actions.ts", "r") as f:
    content = f.read()

content = content.replace("direction: 'in' as const,", "status: 'present' as const,\n    attendance_type: 'check_in' as const,\n    marked_by: teacherId,")

with open("app/manual-attendance/[classId]/actions.ts", "w") as f:
    f.write(content)
