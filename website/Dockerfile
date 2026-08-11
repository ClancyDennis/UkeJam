FROM nginx:1.27-alpine

# Cloud Run sets PORT (default 8080); the template is envsubst'd at startup.
ENV PORT=8080

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY public /usr/share/nginx/html

EXPOSE 8080
