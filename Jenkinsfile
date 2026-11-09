pipeline {
    agent any

    options {
        // Two builds at once would run compose from two workspaces and fight over the same containers.
        disableConcurrentBuilds()
    }

    environment {
        // Frontend gọi API cùng domain; nginx chuyển /api/ sang gateway.
        VITE_API_BASE_URL = '/api'
        CORS_ORIGINS      = 'https://agentshop.id.vn'
    }

    stages {
        stage('Validate Environment') {
            steps {
                echo "Kiểm tra Docker và Docker Compose trên Linux Server..."
                sh 'docker --version'
                sh 'docker compose version'
            }
        }

        stage('Deploy') {
            steps {
                echo "Build và Deploy Frontend + Gateway..."
                // Secret lưu trong Jenkins Credentials (Secret text) — xem DEPLOY_GUIDE.md mục 3.
                withCredentials([
                    string(credentialsId: 'GATEWAY_ADMIN_TOKEN',    variable: 'ADMIN_TOKEN'),
                    string(credentialsId: 'GATEWAY_ENCRYPTION_KEY', variable: 'ENCRYPTION_KEY'),
                ]) {
                    sh '''
                        # KHÔNG dùng "down -v": volume gateway-data chứa database key.
                        docker compose build --no-cache frontend gateway
                        docker compose up -d --remove-orphans
                    '''
                }
            }
        }

        stage('Health Check') {
            steps {
                echo "Đang kiểm tra tình trạng dịch vụ..."
                sh '''
                    for i in $(seq 1 15); do
                        if curl -fsS http://127.0.0.1:3000 >/dev/null && curl -fsS http://127.0.0.1:8090/healthz >/dev/null; then
                            echo "Frontend và Gateway đã sẵn sàng!"
                            exit 0
                        fi
                        sleep 2
                    done
                    echo "Frontend hoặc Gateway chưa sẵn sàng!"
                    exit 1
                '''
            }
        }

        // Chạy sau Health Check: gateway đã lên rồi mới chuyển /api/ sang nó.
        // Script do root cài sẵn trên server, xem DEPLOY_GUIDE.md mục 5.
        stage('Update Nginx') {
            steps {
                script {
                    def installed = sh(
                        script: 'test -x /usr/local/bin/update-nginx-agentshop && sudo -n -l /usr/local/bin/update-nginx-agentshop >/dev/null 2>&1',
                        returnStatus: true,
                    ) == 0
                    if (installed) {
                        sh 'sudo -n /usr/local/bin/update-nginx-agentshop < nginx.conf'
                    } else {
                        unstable('Chưa cài script cập nhật nginx trên server (DEPLOY_GUIDE.md mục 5), bỏ qua bước này.')
                    }
                }
            }
        }
    }

    post {
        always {
            sh 'docker image prune -f || true'
        }
        success {
            echo "CI/CD Pipeline triển khai thành công!"
        }
        failure {
            echo "Pipeline thất bại! Kiểm tra log container:"
            // "docker compose logs" would need the secrets to parse the compose file, so read container logs directly.
            sh 'docker logs --tail=50 quota-gateway || true; docker logs --tail=50 quota-frontend || true'
        }
    }
}
