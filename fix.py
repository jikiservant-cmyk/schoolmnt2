with open("app/dashboard/people/actions.ts", "r") as f:
    lines = f.readlines()

out = []
skip = False
for line in lines:
    if "params.p_pin = null;" in line and "return { error:" in lines[lines.index(line)+1] if lines.index(line)+1 < len(lines) else False:
        out.append("      params.p_pin = null;\n")
        skip = True
        continue
    
    if skip:
        if "params.p_class_ids = classIds" in line:
            skip = False
            out.append(line)
        continue
        
    out.append(line)

with open("app/dashboard/people/actions.ts", "w") as f:
    f.writelines(out)
