pipeline {
    agent any

    environment {
        VITE_API_BASE_URL = 'https://agentshop.id.vn/api'
    }

    stages {
        stage('Validate Environment') {
            steps {
                echo "Kiểm tra Docker và Docker Compose trên Linux Server..."
                sh 'docker --version'
                sh 'docker compose version'
            }
        }

        stage('Deploy Frontend') {
            steps {
                echo "Build và Deploy Frontend..."
                sh '''
                    export VITE_API_BASE_URL="${VITE_API_BASE_URL}"

                    # Build lại image và cập nhật container frontend
                    docker compose down --remove-orphans || true
                    docker compose build --no-cache frontend
                    docker compose up -d --remove-orphans
                '''
            }
        }

        stage('Health Check') {
            steps {
                echo "Đang kiểm tra tình trạng dịch vụ..."
                sleep 3
                sh '''
                    # Kiểm tra Frontend (Port 3000)
                    curl -fsS http://localhost:3000 || (echo "Frontend chưa sẵn sàng!" && exit 1)

                    echo "Frontend đã triển khai thành công!"
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
