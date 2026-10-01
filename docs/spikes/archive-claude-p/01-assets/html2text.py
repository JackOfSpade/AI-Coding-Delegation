import sys,re,html
s=open(sys.argv[1],encoding='utf-8').read()
s=re.sub(r'<script.*?</script>','',s,flags=re.S)
s=re.sub(r'<style.*?</style>','',s,flags=re.S)
# keep table structure
s=re.sub(r'</(tr|p|h1|h2|h3|h4|li|pre|div)>','\n',s)
s=re.sub(r'</t[dh]>',' | ',s)
s=re.sub(r'<br\s*/?>','\n',s)
s=re.sub(r'<[^>]+>','',s)
s=html.unescape(s)
s=re.sub(r'\n\s*\n+','\n',s)
print(s)
