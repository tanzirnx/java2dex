FROM node:20-slim

# ---- Install JDK + tools needed to fetch Android build-tools ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# ---- Install Android command-line tools + build-tools (for d8) ----
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV BUILD_TOOLS_VERSION=34.0.0

RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools && \
    mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

ENV PATH="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${PATH}"

ENV PLATFORM_VERSION=android-34

RUN yes | sdkmanager --sdk_root=${ANDROID_SDK_ROOT} --licenses > /dev/null && \
    sdkmanager --sdk_root=${ANDROID_SDK_ROOT} "build-tools;${BUILD_TOOLS_VERSION}" "platforms;${PLATFORM_VERSION}"

ENV PATH="${ANDROID_SDK_ROOT}/build-tools/${BUILD_TOOLS_VERSION}:${PATH}"
ENV D8_PATH="${ANDROID_SDK_ROOT}/build-tools/${BUILD_TOOLS_VERSION}/d8"
ENV ANDROID_JAR="${ANDROID_SDK_ROOT}/platforms/${PLATFORM_VERSION}/android.jar"

# ---- Install jadx (dex/apk/jar -> Java decompiler) ----
ENV JADX_VERSION=1.5.5
RUN mkdir -p /opt/jadx && \
    wget -q "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" -O /tmp/jadx.zip && \
    unzip -q /tmp/jadx.zip -d /opt/jadx && \
    chmod +x /opt/jadx/bin/jadx && \
    rm /tmp/jadx.zip

ENV PATH="/opt/jadx/bin:${PATH}"
ENV JADX_PATH="/opt/jadx/bin/jadx"

# ---- App setup ----
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
