### Building Examples

- Run `npm run build:examples`, the page is in `examples/dist/` (not committed).
- Deploy it to the `gh-pages` branch:

```bash
cd examples/dist
git init -b gh-pages
git add -A
git commit -m "Deploy examples"
git push --force git@github.com:mjurczyk/three-environment-shadows.git gh-pages
rm -rf .git
```
