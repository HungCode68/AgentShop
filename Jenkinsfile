pipeline {
    agent any

    environment {
        // Cấu hình URL Tyk Gateway theo tên miền chính thức của bạn
        VITE_API_BASE_URL = credentials('VITE_API_BASE_URL') ?: 'https://agentshop.id.vn/api'
        TYK_GW_SECRET     = credentials('TYK_GW_SECRET') ?: 'foo'
    }

    stages {
        stage('Validate Environment') {
            steps {
                echo "Kiểm tra Docker và Docker Compose trên Linux Server..."
                sh 'docker --version'
                sh 'docker compose version'
            }
        }

        stage('Deploy Services') {
            steps {
                echo "Build và Deploy Frontend + Tyk Gateway..."
                sh '''
                    # Export biến môi trường cho Docker Compose
                    export VITE_API_BASE_URL="${VITE_API_BASE_URL}"
                    export TYK_GW_SECRET="${TYK_GW_SECRET}"

                    # Build lại frontend image và khởi động lại các container
                    docker compose down --remove-orphans || true
                    docker compose build --no-cache frontend
                    docker compose up -d --remove-orphans
                '''
            }
        }

        stage('Health Check') {
            steps {
                echo "Đang kiểm tra tình trạng dịch vụ..."
                sleep 5
                sh '''
                    # Kiểm tra Tyk Gateway (Port 8081)
                    curl -fsS http://localhost:8081/hello || (echo "Tyk Gateway chưa sẵn sàng!" && exit 1)

                    # Kiểm tra Frontend (Port 3000)
                    curl -fsS http://localhost:3000 || (echo "Frontend chưa sẵn sàng!" && exit 1)

                    echo "Tất cả dịch vụ đã triển khai thành công!"
                '''
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
            sh 'docker compose logs --tail=50'
        }
    }
}
