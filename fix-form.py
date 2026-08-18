import re
with open("app/dashboard/people/AddPersonForm.tsx", "r") as f:
    content = f.read()

# Remove deviceUserId block
content = re.sub(r'\{\/\* Device Enrollment User ID.*?\n\s+<\/div>', '', content, flags=re.DOTALL)

# Remove pin block
content = re.sub(r'<div className="space-y-1\.5">\s*<label htmlFor="pin".*?<\/div>', '', content, flags=re.DOTALL)

with open("app/dashboard/people/AddPersonForm.tsx", "w") as f:
    f.write(content)
