FROM maven:3-eclipse-temurin-21 AS builder
WORKDIR /app
COPY pom.xml ./
RUN mvn -q -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-alpine-3.22 AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache su-exec && addgroup -S app && adduser -S app -G app
COPY --from=builder /app/target/gptnet-image-0.1.0.jar ./app.jar
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R app:app /app
EXPOSE 4173
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["java", "-jar", "app.jar"]
